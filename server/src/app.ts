import fsSync from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { responseMessage } from './util.js';
import { authRoutes } from './routes/auth.js';
import { providerRoutes } from './routes/providers.js';
import { sessionRoutes } from './routes/sessions.js';
import { photoRoutes } from './routes/photos.js';

export interface BuildAppOptions {
  logger?: boolean;
  /** 测试专用：关闭路由级限速（限速行为由 auth.rate-limit.test.ts 单独覆盖） */
  rateLimit?: boolean;
}

/** 构建 Fastify 应用（不含 listen），供 index.ts 与集成测试共用 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: config.uploadBodyLimit,
  });

  await app.register(cors, { origin: true });
  // 路由级限速：默认开启；E2E 等场景可用 RATE_LIMIT_ENABLED=false 关闭
  // （限速行为本身由 server/test/integration/auth.rate-limit.test.ts 专项覆盖）
  const rateLimitOn =
    opts.rateLimit !== false && (process.env.RATE_LIMIT_ENABLED ?? 'true') !== 'false';
  if (rateLimitOn) {
    await app.register(rateLimit, { global: false });
  }
  await app.register(multipart, {
    limits: {
      fileSize: config.maxFileMb * 1024 * 1024,
      files: config.maxPhotosPerSession,
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues[0]?.message ?? '参数错误' });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: responseMessage(err) });
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(providerRoutes, { prefix: '/api/providers' });
  await app.register(sessionRoutes, { prefix: '/api/sessions' });
  await app.register(photoRoutes, { prefix: '/api/photos' });

  // NFR-13：重启后把中断的任务复位为可重试
  db.exec(`UPDATE photos SET status = 'ready', error = NULL WHERE status = 'analyzing'`);
  // 批量构图任务：进度已持久化在 crop_jobs，重启后只把 running 标志复位（done/total 保留供前端提示）
  db.exec(`UPDATE crop_jobs SET running = 0 WHERE running = 1`);

  // 生产模式：托管前端构建产物（SPA 回退）
  const webDist = process.env.WEB_DIST;
  if (webDist && fsSync.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: path.resolve(webDist) });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
