import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { db } from '../db.js';
import { authPreHandler } from '../auth.js';
import { processImage } from '../services/images.js';
import { startAnalysis, requestCancel, isRunning } from '../services/pipeline.js';
import { selectTopN } from '../services/select.js';
import { startBatchCropSuggest, getCropProgress } from '../services/crop.js';
import { boxToPixelExtract } from '../services/cropBox.js';
import { ensureDir, photoDir, sessionDir } from '../services/storage.js';
import { listProviders } from '../services/providers/registry.js';
import { httpErr } from '../util.js';

function ownSession(req: FastifyRequest, id: string) {
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?')
    .get(id, req.user!.id) as
    | { id: string; user_id: number; provider: string; model: string | null }
    | undefined;
  if (!row) throw httpErr(404, '会话不存在'); // 越权一律 404（AC-F11-5）
  return row;
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: authPreHandler }, async (req) => {
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

  app.get('/', { preHandler: authPreHandler }, async (req) => ({
    sessions: db
      .prepare('SELECT id, provider, model, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.user!.id),
  }));

  app.get('/:id', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const photos = db
      .prepare(
        `SELECT p.*, a.score AS a_score, a.tags AS a_tags, a.issues AS a_issues, a.reason AS a_reason,
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
      session: { id: s.id, provider: s.provider, model: s.model },
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
            : { score: p.a_score, tags: JSON.parse(p.a_tags), issues: JSON.parse(p.a_issues), reason: p.a_reason },
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

  app.post('/:id/photos', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    let processed = (db.prepare('SELECT COUNT(*) AS c FROM photos WHERE session_id = ?').get(s.id) as { c: number }).c;

    const added: string[] = [];
    const failed: Array<{ filename: string; reason: string }> = [];
    const duplicates: string[] = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const filename = part.filename || 'photo';
      if (processed >= config.maxPhotosPerSession) {
        failed.push({ filename, reason: `单会话最多 ${config.maxPhotosPerSession} 张（AC-F1-2）` });
        continue;
      }
      try {
        const buf = await part.toBuffer();
        const info = await processImage(buf, Date.now());
        const dup = db.prepare('SELECT id FROM photos WHERE session_id = ? AND hash = ?').get(s.id, info.hash);
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
        ).run(photoId, s.id, s.user_id, filename, info.hash, info.phash, info.width, info.height, info.takenAt, info.hasExif ? 1 : 0);
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
  });

  app.delete('/:id/photos/:photoId', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const photoId = (req.params as { photoId: string }).photoId;
    const exists = db.prepare('SELECT id FROM photos WHERE id = ? AND session_id = ?').get(photoId, s.id);
    if (!exists) throw httpErr(404, '照片不存在');
    db.prepare('DELETE FROM analyses WHERE photo_id = ?').run(photoId);
    db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);
    await fs.rm(photoDir(s.user_id, s.id, photoId), { recursive: true, force: true });
    return { ok: true };
  });

  app.post('/:id/analyze', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as { provider?: string; model?: string };
    const providers = listProviders();
    const providerId = providers.find((p) => p.id === body.provider)?.id ?? s.provider;
    const cfg = providers.find((p) => p.id === providerId)!;
    const model = (typeof body.model === 'string' && body.model) || cfg.defaultModel;
    db.prepare('UPDATE sessions SET provider = ?, model = ? WHERE id = ?').run(providerId, model, s.id);
    startAnalysis(s.id, providerId, model);
    return { ok: true, provider: providerId, model };
  });

  app.post('/:id/analyze/cancel', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    requestCancel(s.id);
    return { ok: true };
  });

  app.get('/:id/progress', { preHandler: authPreHandler }, async (req) => {
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

  app.post('/:id/select', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const n = Math.max(1, Math.min(Number((req.body as { n?: number } | null)?.n ?? 9), config.maxPhotosPerSession));
    return selectTopN(s.id, n);
  });

  app.delete('/:id', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    db.prepare('DELETE FROM analyses WHERE photo_id IN (SELECT id FROM photos WHERE session_id = ?)').run(s.id);
    db.prepare('DELETE FROM photos WHERE session_id = ?').run(s.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    await fs.rm(sessionDir(s.user_id, s.id), { recursive: true, force: true });
    return { ok: true };
  });

  // AC-F6-1：批量生成构图建议（异步 + 进度轮询）
  app.post('/:id/crop-suggest', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as { force?: boolean };
    startBatchCropSuggest(s.id, s.user_id, s.provider, s.model ?? '', !!body.force);
    return { ok: true };
  });

  app.get('/:id/crop-progress', { preHandler: authPreHandler }, async (req) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    return getCropProgress(s.id);
  });

  // AC-F9-1/2/4：导出 zip（应用裁剪的按原图坐标裁剪，未裁剪的按原图导出）
  app.post('/:id/export', { preHandler: authPreHandler }, async (req, reply) => {
    const s = ownSession(req, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as { photoIds?: string[] };
    let rows = db
      .prepare(
        `SELECT p.*, c.box_x AS c_x, c.box_y AS c_y, c.box_w AS c_w, c.box_h AS c_h
         FROM photos p LEFT JOIN crops c ON c.photo_id = p.id
         WHERE p.session_id = ? AND p.status = 'done'
         ORDER BY p.taken_at, p.created_at`,
      )
      .all(s.id) as any[];
    if (Array.isArray(body.photoIds) && body.photoIds.length > 0) {
      const ids = new Set<string>(body.photoIds);
      rows = rows.filter((r) => ids.has(r.id));
    }
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
      const dir = photoDir(s.user_id, s.id, r.id);
      let data: Buffer;
      if (r.c_x != null && r.width > 0 && r.height > 0) {
        const extract = boxToPixelExtract({ x: r.c_x, y: r.c_y, w: r.c_w, h: r.c_h }, r.width, r.height);
        data = await sharp(path.join(dir, 'original.jpg')).extract(extract).jpeg({ quality: 92 }).toBuffer();
      } else {
        data = await fs.readFile(path.join(dir, 'original.jpg'));
      }
      const safeName = String(r.filename ?? 'photo').replace(/[\\/:*?"<>|]/g, '_');
      archive.append(data, { name: `${String(i + 1).padStart(2, '0')}_${safeName.endsWith('.jpg') || safeName.endsWith('.jpeg') ? safeName : `${safeName}.jpg`}` });
    }
    await archive.finalize();
  });
};
