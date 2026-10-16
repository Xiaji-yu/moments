import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db.js';
import {
  createSession,
  getUserId,
  makeApp,
  makeJpeg,
  register,
  uploadDonePhoto,
  waitFor,
  type App,
} from '../helpers.js';

let app: App;
let token: string;
let userId: number;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'quota_user')).token;
  userId = getUserId('quota_user');
});

afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 造一个已导入且分析完成的会话 */
async function seedAnalyzedSession(name: string): Promise<string> {
  const s = (await createSession(app, token)).id;
  await uploadDonePhoto(app, token, s, userId, {
    name: `${name}.jpg`,
    buf: await makeJpeg(400, 300, { r: 10, g: 20, b: 30 }),
  });
  return s;
}

describe('每日 token 配额（DAILY_TOKEN_LIMIT）', () => {
  it('真实分析消耗 token 后再次触发模型调用 → 429', async () => {
    vi.stubEnv('DAILY_TOKEN_LIMIT', '1'); // 1 token 的极小配额：任何调用都会超
    const s = await seedAnalyzedSession('q1');

    // 第一次分析：配额检查在调用前通过（此时还没用量），分析本身成功
    const first = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: {},
      headers: auth(token),
    });
    expect(first.statusCode).toBe(200);
    await waitFor(async () => {
      const p = (
        await app.inject({ method: 'GET', url: `/api/sessions/${s}/progress`, headers: auth(token) })
      ).json();
      return !p.running && p.done === 1;
    });

    // 已有用量后再触发任何模型调用（重试失败项 / 构图 / 文案）都应被挡住
    const retry = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: { retryFailed: true },
      headers: auth(token),
    });
    // 全部已完成 → 400（先于配额？不：quotaGuard 在 preHandler，先于业务逻辑）→ 429
    expect(retry.statusCode).toBe(429);

    const crop = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    expect(crop.statusCode).toBe(429);

    const caption = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/caption`,
      payload: {},
      headers: auth(token),
    });
    expect(caption.statusCode).toBe(429);
    expect(caption.json().error).toContain('今日模型额度已用完');
  });

  it('单张重试同样受配额约束', async () => {
    vi.stubEnv('DAILY_TOKEN_LIMIT', '1');
    const s = await seedAnalyzedSession('q2');
    const photoId = (
      db.prepare('SELECT id FROM photos WHERE session_id = ?').get(s) as { id: string }
    ).id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/photos/${photoId}/analyze`,
      payload: {},
      headers: auth(token),
    });
    expect(res.statusCode).toBe(429);
  });

  it('未配置配额时不受影响', async () => {
    vi.stubEnv('DAILY_TOKEN_LIMIT', '0');
    const s = await seedAnalyzedSession('q3');
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: { retryFailed: true },
      headers: auth(token),
    });
    // 没有未完成的照片 → 业务层的 400（说明配额没有误拦）
    expect(res.statusCode).toBe(400);
  });

  it('读操作不受配额影响', async () => {
    vi.stubEnv('DAILY_TOKEN_LIMIT', '1');
    const s = await seedAnalyzedSession('q4');
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${s}/progress`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
  });
});
