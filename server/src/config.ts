import path from 'node:path';
import { loadDotEnv } from './env.js';

loadDotEnv(); // 本地 dev 加载项目根 .env（Docker 场景变量已注入，不会覆盖）

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  jwtSecret: env.JWT_SECRET ?? 'dev-secret-please-change-me',
  registerEnabled: (env.REGISTER_ENABLED ?? 'true') !== 'false',
  maxPhotosPerSession: Number(env.MAX_PHOTOS_PER_SESSION ?? 30),
  maxFileMb: Number(env.MAX_FILE_MB ?? 30),
  uploadBodyLimit: Number(env.UPLOAD_BODY_LIMIT ?? 120 * 1024 * 1024),
  modelConcurrency: Math.max(1, Number(env.MODEL_CONCURRENCY ?? 4)),
};
