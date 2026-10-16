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
import { authRoutes } from './routes/auth.js';
import { providerRoutes } from './routes/providers.js';
import { sessionRoutes } from './routes/sessions.js';
import { photoRoutes } from './routes/photos.js';

const app = Fastify({
  logger: true,
  bodyLimit: config.uploadBodyLimit,
});

await app.register(cors, { origin: true });
await app.register(rateLimit, { global: false });
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
  return reply
    .code(status)
    .send({ error: status >= 500 ? '服务器内部错误' : (err as Error).message });
});

await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(providerRoutes, { prefix: '/api/providers' });
await app.register(sessionRoutes, { prefix: '/api/sessions' });
await app.register(photoRoutes, { prefix: '/api/photos' });

// NFR-13：重启后把中断的任务复位为可重试
db.exec(`UPDATE photos SET status = 'ready', error = NULL WHERE status = 'analyzing'`);

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

await app.listen({ port: config.port, host: config.host });
