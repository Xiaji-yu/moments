import type { FastifyPluginAsync } from 'fastify';
import { compareSync, hashSync } from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { authPreHandler, signToken } from '../auth.js';
import { httpErr } from '../util.js';

const CredentialsSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{3,20}$/, '用户名需为 3~20 位字母、数字或下划线'),
  password: z.string().regex(/^(?=.*[A-Za-z])(?=.*\d).{8,}$/, '密码至少 8 位，且需同时包含字母和数字'),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/config', async () => ({ registerEnabled: config.registerEnabled }));

  app.post(
    '/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      if (!config.registerEnabled) throw httpErr(403, '注册已关闭');
      const { username, password } = CredentialsSchema.parse(req.body);
      const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (exists) throw httpErr(409, '用户名已存在');
      const info = db
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run(username, hashSync(password, 10));
      const user = { id: Number(info.lastInsertRowid), username };
      return { token: signToken(user), username };
    },
  );

  app.post(
    '/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const { username, password } = CredentialsSchema.parse(req.body);
      const row = db
        .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
        .get(username) as { id: number; username: string; password_hash: string } | undefined;
      // 统一提示，不泄露账号是否存在（AC-F11-2）
      if (!row || !compareSync(password, row.password_hash)) throw httpErr(401, '用户名或密码错误');
      const user = { id: row.id, username: row.username };
      return { token: signToken(user), username };
    },
  );

  app.get('/me', { preHandler: authPreHandler }, async (req) => ({ username: req.user!.username }));

  app.post('/logout', { preHandler: authPreHandler }, async () => ({ ok: true }));
};
