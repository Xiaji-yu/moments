import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import {
  createSession,
  getUserId,
  insertAnalysisRow,
  insertPhotoRow,
  insertSessionRow,
  makeApp,
  makeJpeg,
  register,
  uploadPhotos,
  waitFor,
  type App,
} from '../helpers.js';

let app: App;
let token: string;
let tokenOther: string;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'flow_user')).token;
  tokenOther = (await register(app, 'flow_other')).token;
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('AI 分析管线（mock 供应商，AC-F3）', () => {
  it('上传 2 张 → analyze → 进度到 done，结果落库', async () => {
    const s = (await createSession(app, token)).id;
    await uploadPhotos(app, token, s, [
      { name: 'one.jpg', buf: await makeJpeg(600, 400, { r: 200, g: 120, b: 40 }) },
      { name: 'two.jpg', buf: await makeJpeg(400, 600, { r: 40, g: 120, b: 200 }) },
    ]);

    const start = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: { provider: 'mock' },
      headers: auth(token),
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, provider: 'mock', model: 'mock-vision' });

    const progress = await waitFor(async () => {
      const r = await app.inject({ method: 'GET', url: `/api/sessions/${s}/progress`, headers: auth(token) });
      const p = r.json();
      return p.done === 2 && !p.running ? p : null;
    });
    expect(progress.total).toBe(2);
    expect(progress.failed).toBe(0);

    const photos = db
      .prepare(`SELECT p.status, a.score, a.tags FROM photos p JOIN analyses a ON a.photo_id = p.id WHERE p.session_id = ?`)
      .all(s) as Array<{ status: string; score: number; tags: string }>;
    expect(photos).toHaveLength(2);
    for (const p of photos) {
      expect(p.status).toBe('done');
      expect(p.score).toBeGreaterThanOrEqual(3);
      expect(JSON.parse(p.tags)).toBeInstanceOf(Array);
    }
  });

  it('进行中重复触发 analyze → 409', async () => {
    const s = (await createSession(app, token)).id;
    await uploadPhotos(app, token, s, [{ name: 'busy.jpg', buf: await makeJpeg(500, 500, { r: 1, g: 2, b: 3 }) }]);
    await app.inject({ method: 'POST', url: `/api/sessions/${s}/analyze`, payload: {}, headers: auth(token) });
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${s}/analyze`, payload: {}, headers: auth(token) });
    expect(res.statusCode).toBe(409);
    await waitFor(async () => {
      const p = (
        await app.inject({ method: 'GET', url: `/api/sessions/${s}/progress`, headers: auth(token) })
      ).json();
      return !p.running && p.done === 1;
    });
  });

  it('取消接口返回 ok，任务最终结束', async () => {
    const s = (await createSession(app, token)).id;
    await uploadPhotos(app, token, s, [{ name: 'c.jpg', buf: await makeJpeg(300, 300, { r: 9, g: 9, b: 9 }) }]);
    await app.inject({ method: 'POST', url: `/api/sessions/${s}/analyze`, payload: {}, headers: auth(token) });
    const cancel = await app.inject({ method: 'POST', url: `/api/sessions/${s}/analyze/cancel`, headers: auth(token) });
    expect(cancel.statusCode).toBe(200);
    await waitFor(async () => {
      const p = (
        await app.inject({ method: 'GET', url: `/api/sessions/${s}/progress`, headers: auth(token) })
      ).json();
      return !p.running;
    });
  });

  it('越权触发他人会话分析 → 404', async () => {
    const s = (await createSession(app, token)).id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/analyze`,
      payload: {},
      headers: auth(tokenOther),
    });
    expect(res.statusCode).toBe(404);
  });

  it('分析后 GET 会话详情带 analysis 字段', async () => {
    const s = (await createSession(app, token)).id;
    await uploadPhotos(app, token, s, [{ name: 'detail.jpg', buf: await makeJpeg(320, 240, { r: 66, g: 66, b: 66 }) }]);
    await app.inject({ method: 'POST', url: `/api/sessions/${s}/analyze`, payload: {}, headers: auth(token) });
    await waitFor(async () => {
      const p = (
        await app.inject({ method: 'GET', url: `/api/sessions/${s}/progress`, headers: auth(token) })
      ).json();
      return !p.running && p.done === 1;
    });
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s}`, headers: auth(token) });
    const photo = (res.json() as { photos: Array<{ analysis: unknown }> }).photos[0];
    expect(photo.analysis).not.toBeNull();
    expect((photo.analysis as { score: number }).score).toBeGreaterThanOrEqual(1);
  });
});

describe('selectTopN（经 API，AC-F5 相似聚类约束）', () => {
  it('有未完成分析的照片时 → 409', async () => {
    const userId = getUserId('flow_user');
    insertSessionRow('sel_pending', userId);
    insertPhotoRow({ id: 'sel_p1', sessionId: 'sel_pending', userId, status: 'ready' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/sel_pending/select',
      payload: { n: 9 },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('未完成分析');
  });

  it('没有任何照片 → 409', async () => {
    const userId = getUserId('flow_user');
    insertSessionRow('sel_empty', userId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/sel_empty/select',
      payload: { n: 9 },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(409);
  });

  it('同组相似照最多入选 1 张；落选原因分类正确（重复/质量问题/内容平淡）', async () => {
    const userId = getUserId('flow_user');
    insertSessionRow('sel_mix', userId);
    // 组 1：p_a(9) 与 p_b(7) phash 相同（距离 0）；p_c 与它们距离 64 → 独立组
    insertPhotoRow({ id: 'p_a', sessionId: 'sel_mix', userId, phash: 'aaaaaaaaaaaaaaaa', takenAt: '2024-01-01T00:00:00Z', hasExif: true });
    insertPhotoRow({ id: 'p_b', sessionId: 'sel_mix', userId, phash: 'aaaaaaaaaaaaaaaa', takenAt: '2024-01-01T00:00:05Z', hasExif: true });
    insertPhotoRow({ id: 'p_c', sessionId: 'sel_mix', userId, phash: '5555555555555555', takenAt: '2024-01-01T00:01:00Z', hasExif: true });
    insertAnalysisRow('p_a', { score: 9, tags: ['海边'], reason: 'A 光线佳' });
    insertAnalysisRow('p_b', { score: 7, tags: ['海边'], reason: 'B 略逊' });
    insertAnalysisRow('p_c', { score: 5, issues: ['模糊'], reason: 'C 一般' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/sel_mix/select',
      payload: { n: 3 },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const { selected, rejected } = res.json();

    expect(selected.map((x: { photoId: string }) => x.photoId).sort()).toEqual(['p_a', 'p_c']);
    expect(selected.map((x: { order: number }, i: number) => x.order)).toEqual([1, 2]);

    const byId = new Map(rejected.map((r: { photoId: string }) => [r.photoId, r]));
    expect(byId.get('p_b').category).toBe('重复'); // 同组更优者已入选
    // p_c 入选，rejected 里没有它
    expect(byId.has('p_c')).toBe(false);
  });

  it('n 限制生效：n=1 只返回最高分一张', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/sel_mix/select',
      payload: { n: 1 },
      headers: auth(token),
    });
    const { selected } = res.json();
    expect(selected).toHaveLength(1);
    expect(selected[0].photoId).toBe('p_a'); // 最高分
  });

  it('按拍摄时间 ≤2s 连拍归组：n=1 时同组两张只出一张', async () => {
    const userId = getUserId('flow_user');
    insertSessionRow('sel_burst', userId);
    // b1/b2 拍摄间隔 1.5s（≤2s 连拍同组）；b3 与二者时间、pHash 均无关
    insertPhotoRow({
      id: 'b1',
      sessionId: 'sel_burst',
      userId,
      phash: 'ff00ff0000000000',
      takenAt: '2024-02-01T10:00:00.000Z',
      hasExif: true,
    });
    insertPhotoRow({
      id: 'b2',
      sessionId: 'sel_burst',
      userId,
      phash: '00ff00ff00000000',
      takenAt: '2024-02-01T10:00:01.500Z',
      hasExif: true,
    });
    insertPhotoRow({
      id: 'b3',
      sessionId: 'sel_burst',
      userId,
      phash: '5555555555555555',
      takenAt: '2024-02-01T10:05:00.000Z',
      hasExif: true,
    });
    insertAnalysisRow('b1', { score: 8, reason: 'b1' });
    insertAnalysisRow('b2', { score: 6, reason: 'b2' });
    insertAnalysisRow('b3', { score: 5, reason: 'b3' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/sel_burst/select',
      payload: { n: 2 },
      headers: auth(token),
    });
    const { selected, rejected } = res.json();
    // b1、b2 是连拍同组 → 只入 b1；b3 独立入选
    expect(selected.map((x: { photoId: string }) => x.photoId)).toEqual(['b1', 'b3']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].photoId).toBe('b2');
    expect(rejected[0].category).toBe('重复');
  });

  it('落选且无 issues 的高分照片 → 内容平淡', async () => {
    const userId = getUserId('flow_user');
    insertSessionRow('sel_plain', userId);
    insertPhotoRow({ id: 'x1', sessionId: 'sel_plain', userId, phash: '0000000000000000', takenAt: '2024-03-01T00:00:00Z', hasExif: true });
    insertPhotoRow({ id: 'x2', sessionId: 'sel_plain', userId, phash: 'ffffffffffffffff', takenAt: '2024-03-01T00:01:00Z', hasExif: true });
    insertAnalysisRow('x1', { score: 9 });
    insertAnalysisRow('x2', { score: 4 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/sel_plain/select',
      payload: { n: 1 },
      headers: auth(token),
    });
    const { rejected } = res.json();
    expect(rejected[0].photoId).toBe('x2');
    expect(rejected[0].category).toBe('内容平淡');
    expect(rejected[0].detail).toContain('4 分');
  });

  it('质量问题落选：issues 透出为 detail', async () => {
    const userId = getUserId('flow_user');
    insertSessionRow('sel_issue', userId);
    insertPhotoRow({ id: 'y1', sessionId: 'sel_issue', userId, phash: 'c111111111111111' });
    insertPhotoRow({ id: 'y2', sessionId: 'sel_issue', userId, phash: '3ccccccccccccccc' });
    insertAnalysisRow('y1', { score: 9 });
    insertAnalysisRow('y2', { score: 3, issues: ['过曝', '闭眼'] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/sel_issue/select',
      payload: { n: 1 },
      headers: auth(token),
    });
    const { rejected } = res.json();
    expect(rejected[0].category).toBe('质量问题');
    expect(rejected[0].detail).toBe('过曝、闭眼');
  });
});
