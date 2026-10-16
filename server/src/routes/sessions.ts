import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { db } from '../db.js';
import { authPreHandler } from '../auth.js';
import { quotaGuard } from '../services/quota.js';
import { processImage } from '../services/images.js';
import { startAnalysis, requestCancel, isRunning } from '../services/pipeline.js';
import { selectTopN } from '../services/select.js';
import {
  startBatchCropSuggest,
  getCropProgress,
  requestCancelBatchCrop,
} from '../services/crop.js';
import { generateCaptions, readCaptions, saveCaptions } from '../services/caption.js';
import { getSessionUsage } from '../services/usage.js';
import { ensureDir, photoDir, sessionDir } from '../services/storage.js';
import { listProviders } from '../services/providers/registry.js';
import { loadExportImage, safeFilename } from '../services/export.js';
import { composeGrid } from '../services/grid.js';
import { httpErr } from '../util.js';

/** 路由级限速档位（配合 app.ts 注册的 @fastify/rate-limit，按 IP 计数） */
const RL = {
  /** 读操作 / 轻量写操作 */
  light: { max: 60, timeWindow: '1 minute' },
  /** 上传、导出等重操作 */
  heavy: { max: 10, timeWindow: '1 minute' },
  /** 会触发模型调用的操作（配额之外的第二道闸） */
  model: { max: 5, timeWindow: '1 minute' },
} as const;

function ownSession(req: FastifyRequest, id: string) {
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?')
    .get(id, req.user!.id) as
    | { id: string; user_id: number; title: string | null; provider: string; model: string | null }
    | undefined;
  if (!row) throw httpErr(404, '会话不存在'); // 越权一律 404（AC-F11-5）
  return row;
}

/**
 * 超限/跳过的文件不进入处理，但必须排空其流：
 * 否则 busboy 背压会让 req.parts() 迭代永久挂起，请求无响应。
 */
async function discardFilePart(part: { file: NodeJS.ReadableStream }): Promise<void> {
  await new Promise<void>((resolve) => {
    part.file.on('end', resolve);
    part.file.on('error', resolve);
    (part.file as { resume: () => void }).resume();
  });
}

/** 取会话内已完成分析的照片（LEFT JOIN 已应用的裁剪），按需按 id 集合过滤/排序 */
function loadExportRows(sessionId: string, photoIds?: string[]) {
  let rows = db
    .prepare(
      `SELECT p.*, c.box_x AS c_x, c.box_y AS c_y, c.box_w AS c_w, c.box_h AS c_h
       FROM photos p LEFT JOIN crops c ON c.photo_id = p.id
       WHERE p.session_id = ? AND p.status = 'done'`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  if (Array.isArray(photoIds) && photoIds.length > 0) {
    // 按传入顺序导出（与九宫格排版顺序一致，AC-F9-2）
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    rows = photoIds.map((id) => byId.get(id)).filter((r) => r != null);
  } else {
    rows = rows.sort((a, b) => ((a.taken_at as string) < (b.taken_at as string) ? -1 : 1));
  }
  return rows;
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const body = (req.body ?? {}) as { provider?: string };
    const providers = listProviders();
    const provider = providers.find((p) => p.id === body.provider)?.id ?? providers[0].id;
    const model = providers.find((p) => p.id === provider)!.defaultModel;
    const id = nanoid(12);
    db.prepare('INSERT INTO sessions (id, user_id, provider, model) VALUES (?, ?, ?, ?)').run(
      id,
      req.user!.id,
      provider,
      model,
    );
    await ensureDir(sessionDir(req.user!.id, id));
    return { id, provider, model };
  });

  app.get('/', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => ({
    sessions: db
      .prepare(
        `SELECT s.id, s.title, s.provider, s.model, s.created_at,
                (SELECT COUNT(*) FROM photos p WHERE p.session_id = s.id) AS photo_count
         FROM sessions s WHERE s.user_id = ? ORDER BY s.created_at DESC, s.rowid DESC`,
      )
      .all(req.user!.id),
  }));

  app.get('/:id', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const photos = db
      .prepare(
        `SELECT p.*, a.score AS a_score, a.tags AS a_tags, a.issues AS a_issues, a.reason AS a_reason, a.feedback AS a_feedback,
                cs.ratio AS cs_ratio, cs.box_x AS cs_x, cs.box_y AS cs_y, cs.box_w AS cs_w, cs.box_h AS cs_h, cs.reasoning AS cs_reason,
                c.ratio AS c_ratio, c.box_x AS c_x, c.box_y AS c_y, c.box_w AS c_w, c.box_h AS c_h, c.source AS c_source
         FROM photos p
         LEFT JOIN analyses a ON a.photo_id = p.id
         LEFT JOIN crop_suggestions cs ON cs.photo_id = p.id
         LEFT JOIN crops c ON c.photo_id = p.id
         WHERE p.session_id = ? ORDER BY p.taken_at, p.created_at`,
      )
      .all(s.id) as any[];
    return {
      session: { id: s.id, title: s.title, provider: s.provider, model: s.model },
      photos: photos.map((p) => ({
        id: p.id,
        filename: p.filename,
        status: p.status,
        error: p.error,
        width: p.width,
        height: p.height,
        takenAt: p.taken_at,
        hasExif: !!p.has_exif,
        analysis:
          p.a_score == null
            ? null
            : {
                score: p.a_score,
                tags: JSON.parse(p.a_tags),
                issues: JSON.parse(p.a_issues),
                reason: p.a_reason,
                feedback: (p.a_feedback ?? 0) as number,
              },
        cropSuggestion:
          p.cs_ratio == null
            ? null
            : {
                ratio: p.cs_ratio,
                box: { x: p.cs_x, y: p.cs_y, w: p.cs_w, h: p.cs_h },
                reasoning: p.cs_reason,
              },
        crop:
          p.c_ratio == null
            ? null
            : { ratio: p.c_ratio, box: { x: p.c_x, y: p.c_y, w: p.c_w, h: p.c_h }, source: p.c_source },
      })),
    };
  });

  /** 重命名会话 */
  app.patch('/:id', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as { title?: string };
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 40) : null;
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, s.id);
    return { ok: true, title };
  });

  app.post(
    '/:id/photos',
    { preHandler: authPreHandler, config: { rateLimit: RL.heavy } },
    async (req) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      let processed = (
        db.prepare('SELECT COUNT(*) AS c FROM photos WHERE session_id = ?').get(s.id) as { c: number }
      ).c;

      const added: string[] = [];
      const failed: Array<{ filename: string; reason: string }> = [];
      const duplicates: string[] = [];

      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const filename = part.filename || 'photo';
        if (processed >= config.maxPhotosPerSession) {
          failed.push({ filename, reason: `单会话最多 ${config.maxPhotosPerSession} 张（AC-F1-2）` });
          await discardFilePart(part);
          continue;
        }
        try {
          const buf = await part.toBuffer();
          const info = await processImage(buf, Date.now());
          const dup = db
            .prepare('SELECT id FROM photos WHERE session_id = ? AND hash = ?')
            .get(s.id, info.hash);
          if (dup) {
            duplicates.push(filename); // AC-F1-5
            continue;
          }
          const photoId = nanoid(12);
          const dir = photoDir(s.user_id, s.id, photoId);
          await ensureDir(dir);
          await Promise.all([
            fs.writeFile(path.join(dir, 'original.jpg'), info.original),
            fs.writeFile(path.join(dir, 'thumb.jpg'), info.thumb),
            fs.writeFile(path.join(dir, 'send.jpg'), info.send),
          ]);
          db.prepare(
            `INSERT INTO photos (id, session_id, user_id, filename, hash, phash, width, height, taken_at, has_exif)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            photoId,
            s.id,
            s.user_id,
            filename,
            info.hash,
            info.phash,
            info.width,
            info.height,
            info.takenAt,
            info.hasExif ? 1 : 0,
          );
          added.push(filename);
          processed++;
        } catch (err) {
          const code = (err as { code?: string }).code;
          const tooLarge = code === 'FST_REQ_FILE_TOO_LARGE' || String((err as Error).message).includes('too large');
          failed.push({
            filename,
            reason: tooLarge
              ? `文件超过 ${config.maxFileMb}MB 限制`
              : '图片处理失败（格式不支持或文件损坏）',
          });
        }
      }
      return { added: added.length, failed, duplicates };
    },
  );

  app.delete(
    '/:id/photos/:photoId',
    { preHandler: authPreHandler, config: { rateLimit: RL.light } },
    async (req) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      const photoId = (req.params as { photoId: string }).photoId;
      const exists = db
        .prepare('SELECT id FROM photos WHERE id = ? AND session_id = ?')
        .get(photoId, s.id);
      if (!exists) throw httpErr(404, '照片不存在');
      db.prepare('DELETE FROM analyses WHERE photo_id = ?').run(photoId);
      db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);
      await fs.rm(photoDir(s.user_id, s.id, photoId), { recursive: true, force: true });
      return { ok: true };
    },
  );

  /**
   * 启动分析。body 可选：
   * - photoIds: string[]  只分析这些照片
   * - retryFailed: true   只分析未完成的（ready/failed），已完成的跳过
   */
  app.post(
    '/:id/analyze',
    { preHandler: [authPreHandler, quotaGuard], config: { rateLimit: RL.model } },
    async (req) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      const body = (req.body ?? {}) as {
        provider?: string;
        model?: string;
        photoIds?: string[];
        retryFailed?: boolean;
      };
      const providers = listProviders();
      const providerId = providers.find((p) => p.id === body.provider)?.id ?? s.provider;
      const cfg = providers.find((p) => p.id === providerId)!;
      const model = (typeof body.model === 'string' && body.model) || cfg.defaultModel;
      db.prepare('UPDATE sessions SET provider = ?, model = ? WHERE id = ?').run(providerId, model, s.id);
      startAnalysis(s.id, providerId, model, {
        photoIds: Array.isArray(body.photoIds) && body.photoIds.length > 0 ? body.photoIds : undefined,
        onlyPending: body.retryFailed === true,
      });
      return { ok: true, provider: providerId, model };
    },
  );

  app.post(
    '/:id/analyze/cancel',
    { preHandler: authPreHandler, config: { rateLimit: RL.light } },
    async (req) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      requestCancel(s.id);
      return { ok: true };
    },
  );

  app.get('/:id/progress', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const rows = db
      .prepare('SELECT status, COUNT(*) AS c FROM photos WHERE session_id = ? GROUP BY status')
      .all(s.id) as Array<{ status: string; c: number }>;
    const counts = Object.fromEntries(rows.map((r) => [r.status, r.c]));
    return {
      total: rows.reduce((n, r) => n + r.c, 0),
      ready: counts.ready ?? 0,
      analyzing: counts.analyzing ?? 0,
      done: counts.done ?? 0,
      failed: counts.failed ?? 0,
      running: isRunning(s.id),
    };
  });

  app.post('/:id/select', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const n = Math.max(
      1,
      Math.min(Number((req.body as { n?: number } | null)?.n ?? 9), config.maxPhotosPerSession),
    );
    return selectTopN(s.id, n);
  });

  app.delete('/:id', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    requestCancelBatchCrop(s.id); // 让可能还在跑的批量任务尽快退出
    db.prepare('DELETE FROM analyses WHERE photo_id IN (SELECT id FROM photos WHERE session_id = ?)').run(s.id);
    db.prepare('DELETE FROM photos WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    await fs.rm(sessionDir(s.user_id, s.id), { recursive: true, force: true });
    return { ok: true };
  });

  // AC-F6-1：批量生成构图建议（异步 + 进度轮询）；photoIds 限定范围（如 AI 推荐的若干张）
  app.post(
    '/:id/crop-suggest',
    { preHandler: [authPreHandler, quotaGuard], config: { rateLimit: RL.model } },
    async (req) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      const body = (req.body ?? {}) as { force?: boolean; photoIds?: string[] };
      const photoIds = Array.isArray(body.photoIds) && body.photoIds.length > 0 ? body.photoIds : undefined;
      startBatchCropSuggest(s.id, s.user_id, s.provider, s.model ?? '', !!body.force, photoIds);
      return { ok: true };
    },
  );

  app.post(
    '/:id/crop-suggest/cancel',
    { preHandler: authPreHandler, config: { rateLimit: RL.light } },
    async (req) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      requestCancelBatchCrop(s.id);
      return { ok: true };
    },
  );

  app.get(
    '/:id/crop-progress',
    { preHandler: authPreHandler, config: { rateLimit: RL.light } },
    async (req) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      return getCropProgress(s.id);
    },
  );

  // AC-F9-1/2/4：导出 zip（应用裁剪的按原图坐标裁剪，未裁剪的按原图导出）
  app.post(
    '/:id/export',
    { preHandler: authPreHandler, config: { rateLimit: RL.heavy } },
    async (req, reply) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      const body = (req.body ?? {}) as { photoIds?: string[] };
      const rows = loadExportRows(s.id, body.photoIds);
      if (rows.length === 0) throw httpErr(409, '没有可导出的照片');

      const archive = new ZipArchive({ zlib: { level: 9 } });
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="moments-${s.id}.zip"`,
        'Transfer-Encoding': 'chunked',
      });
      archive.pipe(reply.raw);

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const data = await loadExportImage(s.user_id, s.id, r as never);
        const safeName = safeFilename(String(r.filename ?? 'photo'));
        const name = `${String(i + 1).padStart(2, '0')}_${
          safeName.endsWith('.jpg') || safeName.endsWith('.jpeg') ? safeName : `${safeName}.jpg`
        }`;
        archive.append(data, { name });
      }
      // AC-F9-1：文案一并打包
      const captionItems = readCaptions(s.id);
      if (captionItems && captionItems.length > 0) {
        archive.append(captionItems.map((c) => c.text).join('\n\n'), { name: 'caption.txt' });
      }
      await archive.finalize();
    },
  );

  // AC-F8：按排版顺序导出单张网格拼图（朋友圈单图发布的最终产物）
  app.post(
    '/:id/export-grid',
    { preHandler: authPreHandler, config: { rateLimit: RL.heavy } },
    async (req, reply) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      const body = (req.body ?? {}) as { photoIds?: string[]; cols?: number; cell?: number; gap?: number };
      const rows = loadExportRows(s.id, body.photoIds);
      if (rows.length === 0) throw httpErr(409, '没有可导出的照片');

      const cols = Math.max(1, Math.min(4, Math.floor(Number(body.cols) || 3)));
      const images = [];
      for (const r of rows) images.push(await loadExportImage(s.user_id, s.id, r as never));
      const jpg = await composeGrid(images, { cols, cell: body.cell, gap: body.gap });

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Disposition': `attachment; filename="moments-grid-${s.id}.jpg"`,
        'Content-Length': jpg.length,
      });
      reply.raw.end(jpg);
    },
  );

  // AC-F7-1：生成文案（仅文本模型调用）
  app.post(
    '/:id/caption',
    { preHandler: [authPreHandler, quotaGuard], config: { rateLimit: RL.heavy } },
    async (req) => {
      const s = ownSession(req, (req.params as { id: string }).id);
      const body = (req.body ?? {}) as { style?: string; note?: string; photoIds?: string[] };
      const style = (['混合', '简洁', '文艺', '搞笑'] as const).includes(body.style as never)
        ? (body.style as '混合' | '简洁' | '文艺' | '搞笑')
        : '混合';
      const items = await generateCaptions(s.id, s.user_id, style, body.note, body.photoIds);
      return { items };
    },
  );

  app.get('/:id/caption', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    return { items: readCaptions(s.id) };
  });

  // AC-F7-4：用户编辑后保存
  app.put('/:id/caption', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as { items?: Array<{ style?: string; text?: string }> };
    if (!Array.isArray(body.items)) throw httpErr(400, 'items 不能为空');
    saveCaptions(s.id, s.user_id, body.items as never);
    return { ok: true, items: readCaptions(s.id) };
  });

  // NFR-2：token 用量与费用估算
  app.get('/:id/usage', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    return getSessionUsage(s.id);
  });
};
