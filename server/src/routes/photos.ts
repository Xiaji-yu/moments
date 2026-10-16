import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { authPreHandler } from '../auth.js';
import { quotaGuard } from '../services/quota.js';
import { photoDir } from '../services/storage.js';
import { suggestCropForPhoto, saveCrop } from '../services/crop.js';
import { retryOne } from '../services/pipeline.js';
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
      const session = db
        .prepare('SELECT provider, model FROM sessions WHERE id = ?')
        .get(photo.session_id) as { provider: string; model: string | null };
      await suggestCropForPhoto(photo.session_id, photo.user_id, photo.id, session.provider, session.model ?? '');
      return { ok: true };
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
    const suggestion = db.prepare('SELECT * FROM crop_suggestions WHERE photo_id = ?').get(photo.id) ?? null;
    const crop = db.prepare('SELECT * FROM crops WHERE photo_id = ?').get(photo.id) ?? null;
    return { suggestion, crop };
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
