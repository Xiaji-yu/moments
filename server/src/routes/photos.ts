import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { authPreHandler } from '../auth.js';
import { photoDir } from '../services/storage.js';
import { httpErr } from '../util.js';

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

export const photoRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/thumb', { preHandler: authPreHandler }, async (req, reply) => sendPhotoFile(req, reply, 'thumb.jpg'));
  app.get('/:id/image', { preHandler: authPreHandler }, async (req, reply) =>
    sendPhotoFile(req, reply, 'original.jpg'),
  );
};
