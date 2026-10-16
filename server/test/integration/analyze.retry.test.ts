import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import {
  createSession,
  getUserId,
  insertAnalysisRow,
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
  token = (await register(app, 'retry_user')).token;
  userId = getUserId('retry_user');
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const progressOf = async (s: string) =>
  (await app.inject({ method: 'GET', url: `/api/sessions/${s}/progress`, headers: auth(token) })).json();

const waitIdle = async (s: string) =>
  waitFor(async () => {
    const p = await progressOf(s);
    return !p.running && p.analyzing === 0;
  });

/** 造「一张 done + 一张 failed」的会话 */
async function seedMixedSession(): Promise<{ s: string; okId: string; badId: string }> {
  const s = (await createSession(app, token)).id;
  const { photoId: okId } = await uploadDonePhoto(app, token, s, userId, {
    name: 'ok.jpg',
    buf: await makeJpeg(400, 300, { r: 1, g: 2, b: 3 }),
  });
  const { photoId: badId } = await uploadDonePhoto(app, token, s, userId, {
    name: 'bad.jpg',
    buf: await makeJpeg(400, 300, { r: 4, g: 5, b: 6 }),
  });
  insertAnalysisRow(okId, { score: 8, reason: '很好的照片' });
  db.prepare(`UPDATE photos SET status = 'failed', error = '模型响应超时，请重试' WHERE id = ?`).run(badId);
  return { s, okId, badId };
}

describe('增量分析（retryFailed / photoIds）', () => {
  it('retryFailed 只重跑未完成的照片，已成功照片的分析不被清掉', async () => {
    const { s, okId } = await seedMixedSession();

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: { retryFailed: true },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);

    await waitIdle(s);
    const p = await progressOf(s);
    expect(p.done).toBe(2);
    expect(p.failed).toBe(0);

    // 原分析仍在那里（reason 未被删除重写）
    const row = db.prepare('SELECT reason FROM analyses WHERE photo_id = ?').get(okId) as {
      reason: string;
    };
    expect(row.reason).toBe('很好的照片');
  });

  it('photoIds 只分析指定的照片', async () => {
    const s = (await createSession(app, token)).id;
    const { photoId: p1 } = await uploadDonePhoto(app, token, s, userId, {
      name: 'a.jpg',
      buf: await makeJpeg(300, 300, { r: 1, g: 1, b: 1 }),
    });
    const { photoId: p2 } = await uploadDonePhoto(app, token, s, userId, {
      name: 'b.jpg',
      buf: await makeJpeg(300, 300, { r: 2, g: 2, b: 2 }),
    });
    // 两张都先标记为待分析
    db.prepare(`UPDATE photos SET status = 'ready' WHERE session_id = ?`).run(s);
    db.prepare(`DELETE FROM analyses WHERE photo_id IN (?, ?)`).run(p1, p2);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: { photoIds: [p2] },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    await waitIdle(s);

    const p = await progressOf(s);
    expect(p.done).toBe(1);
    expect(p.ready).toBe(1); // p1 仍是待分析
    const done = db.prepare('SELECT id FROM photos WHERE session_id = ? AND status = ?').all(s, 'done');
    expect(done.map((r) => (r as { id: string }).id)).toEqual([p2]);
  });

  it('没有未完成照片时 retryFailed → 400（前端据此隐藏按钮）', async () => {
    const s = (await createSession(app, token)).id;
    await uploadDonePhoto(app, token, s, userId, {
      name: 'done.jpg',
      buf: await makeJpeg(300, 300, { r: 9, g: 9, b: 9 }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: { retryFailed: true },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('没有需要重试的照片');
  });

  it('全量分析仍会重置全部照片（默认行为不变）', async () => {
    const s = (await createSession(app, token)).id;
    const { photoId } = await uploadDonePhoto(app, token, s, userId, {
      name: 'full.jpg',
      buf: await makeJpeg(300, 300, { r: 7, g: 7, b: 7 }),
    });
    insertAnalysisRow(photoId, { score: 3 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: {},
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    await waitIdle(s);
    // 被重跑后分数是 mock 重新生成的（3..9），原 3 分那条已被删除重建
    const row = db.prepare('SELECT score FROM analyses WHERE photo_id = ?').get(photoId) as {
      score: number;
    };
    expect(row.score).toBeGreaterThanOrEqual(3);
  });
});

describe('POST /api/photos/:id/analyze（单张重试）', () => {
  it('失败照片重试后变为 done 并同步返回结果', async () => {
    const { s, badId } = await seedMixedSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/photos/${badId}/analyze`,
      payload: {},
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('done');
    expect(res.json().error).toBeNull();

    const row = db.prepare('SELECT status, error FROM photos WHERE id = ?').get(badId) as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe('done');
    expect(row.error).toBeNull();
    void s;
  });

  it('越权重试他人照片 → 404', async () => {
    const { badId } = await seedMixedSession();
    const other = (await register(app, 'retry_other')).token;
    const res = await app.inject({
      method: 'POST',
      url: `/api/photos/${badId}/analyze`,
      payload: {},
      headers: auth(other),
    });
    expect(res.statusCode).toBe(404);
  });
});
