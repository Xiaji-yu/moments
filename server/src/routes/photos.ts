import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { authPreHandler } from '../auth.js';
import { quotaGuard } from '../services/quota.js';
import { photoDir } from '../services/storage.js';
import { suggestCropForPhoto, saveCrop, CROP_SUGGEST_VERSION } from '../services/crop.js';
import { retryOne } from '../services/pipeline.js';
import { listProviders, defaultProviderId } from '../services/providers/registry.js';
import { httpErr } from '../util.js';

/** 路由级限速档位（与 routes/sessions.ts 保持一致） */
const RL = {
  light: { max: 60, timeWindow: '1 minute' },
  model: { max: 5, timeWindow: '1 minute' },
} as const;

async function sendPhotoFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: 'thumb.jpg' | 'original.jpg',
): Promise<FastifyReply> {
  const row = db
    .prepare(
      `SELECT p.id, p.session_id AS sid, s.user_id
       FROM photos p JOIN sessions s ON s.id = p.session_id
       WHERE p.id = ? AND s.user_id = ?`,
    )
    .get((req.params as { id: string }).id, req.user!.id) as
    | { id: string; sid: string; user_id: number }
    | undefined;
  if (!row) throw httpErr(404, '照片不存在'); // 越权一律 404（AC-F11-5）
  const data = await fs.readFile(path.join(photoDir(row.user_id, row.sid, row.id), file));
  return reply.type('image/jpeg').send(data);
}

function ownedPhoto(req: FastifyRequest) {
  const row = db
    .prepare(
      `SELECT p.*, s.user_id FROM photos p JOIN sessions s ON s.id = p.session_id WHERE p.id = ? AND s.user_id = ?`,
    )
    .get((req.params as { id: string }).id, req.user!.id) as
    | { id: string; session_id: string; user_id: number; status: string }
    | undefined;
  if (!row) throw httpErr(404, '照片不存在');
  return row;
}

interface SuggestionDbRow {
  ratio: string;
  box_x: number;
  box_y: number;
  box_w: number;
  box_h: number;
  reasoning: string;
  model: string | null;
  version: number;
  warnings: string;
}

/** crop_suggestions 行 → 前端 CropSuggestion（box 对象 + warnings/stale） */
function mapSuggestion(row: SuggestionDbRow, sessionModel: string | null) {
  let warnings: string[] = [];
  try {
    const v = JSON.parse(row.warnings);
    if (Array.isArray(v)) warnings = v.filter((x): x is string => typeof x === 'string');
  } catch {
    // 旧数据没有 warnings 列值，忽略
  }
  return {
    ratio: row.ratio,
    box: { x: row.box_x, y: row.box_y, w: row.box_w, h: row.box_h },
    reasoning: row.reasoning,
    warnings,
    model: row.model,
    stale: row.version !== CROP_SUGGEST_VERSION || (row.model ?? '') !== (sessionModel ?? ''),
  };
}

export const photoRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/:id/thumb',
    { preHandler: authPreHandler, config: { rateLimit: RL.light } },
    async (req, reply) => sendPhotoFile(req, reply, 'thumb.jpg'),
  );
  app.get(
    '/:id/image',
    { preHandler: authPreHandler, config: { rateLimit: RL.light } },
    async (req, reply) => sendPhotoFile(req, reply, 'original.jpg'),
  );

  // AC-F6-1：单张生成二次构图建议
  app.post(
    '/:id/crop-suggest',
    { preHandler: [authPreHandler, quotaGuard], config: { rateLimit: RL.model } },
    async (req) => {
      const photo = ownedPhoto(req);
      const body = (req.body ?? {}) as { provider?: string; model?: string };
      const providers = listProviders();
      const session = db
        .prepare('SELECT provider, model FROM sessions WHERE id = ?')
        .get(photo.session_id) as { provider: string; model: string | null };
      // 弹窗里「生成 AI 建议」同样以请求里的供应商/模型为准（与批量接口保持一致）
      const providerId =
        providers.find((p) => p.id === body.provider)?.id ??
        (providers.some((p) => p.id === session.provider) ? session.provider : defaultProviderId(providers));
      const cfg = providers.find((p) => p.id === providerId)!;
      const model = (typeof body.model === 'string' && body.model) || cfg.defaultModel;
      db.prepare('UPDATE sessions SET provider = ?, model = ? WHERE id = ?').run(providerId, model, photo.session_id);
      await suggestCropForPhoto(photo.session_id, photo.user_id, photo.id, providerId, model);
      return { ok: true, provider: providerId, model };
    },
  );

  // AC-F6-3/6：保存应用的裁剪（box 已在服务端 normalizeBox 硬校验）
  app.put('/:id/crop', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const photo = ownedPhoto(req);
    saveCrop(photo.id, photo.session_id, photo.user_id, (req.body ?? {}) as never);
    const crop = db.prepare('SELECT * FROM crops WHERE photo_id = ?').get(photo.id);
    return { ok: true, crop: crop ?? null };
  });

  app.get('/:id/crop', { preHandler: authPreHandler, config: { rateLimit: RL.light } }, async (req) => {
    const photo = ownedPhoto(req);
    const row = db.prepare('SELECT * FROM crop_suggestions WHERE photo_id = ?').get(photo.id) as
      | SuggestionDbRow
      | undefined;
    const crop = db.prepare('SELECT * FROM crops WHERE photo_id = ?').get(photo.id);
    const session = db.prepare('SELECT model FROM sessions WHERE id = ?').get(photo.session_id) as {
      model: string | null;
    };
    // 统一成前端类型（box 对象），否则弹窗里 setBox(res.suggestion.box) 会拿到 undefined
    return {
      suggestion: row ? mapSuggestion(row, session.model) : null,
      crop: crop ?? null,
    };
  });

  /** 单张重试分析：同步等待并返回结果，失败时把可读原因带给前端 */
  app.post(
    '/:id/analyze',
    { preHandler: [authPreHandler, quotaGuard], config: { rateLimit: RL.model } },
    async (req) => {
      const photo = ownedPhoto(req);
      const session = db
        .prepare('SELECT provider, model FROM sessions WHERE id = ?')
        .get(photo.session_id) as { provider: string; model: string | null };
      const result = await retryOne(
        photo.session_id,
        photo.user_id,
        photo.id,
        session.provider,
        session.model ?? '',
      );
      return { ok: true, status: result.status, error: result.error };
    },
  );

  /** 对 AI 挑图结果的反馈（1 = 赞 / -1 = 踩 / 0 = 清除），用于后续调优 prompt */
  app.put(
    '/:id/feedback',
    { preHandler: authPreHandler, config: { rateLimit: RL.light } },
    async (req) => {
      const photo = ownedPhoto(req);
      const body = (req.body ?? {}) as { feedback?: number };
      const feedback = body.feedback === 1 || body.feedback === -1 ? body.feedback : 0;
      const changed = db.prepare('UPDATE analyses SET feedback = ? WHERE photo_id = ?').run(feedback, photo.id);
      if (changed.changes === 0) throw httpErr(409, '该照片还没有分析结果，无法反馈');
      return { ok: true, feedback };
    },
  );
};
