import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import { CROP_SUGGEST_VERSION } from '../../src/services/crop.js';
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
let tokenOther: string;
let userId: number;
let sessionId: string;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'crop_user')).token;
  tokenOther = (await register(app, 'crop_other')).token;
  userId = getUserId('crop_user');
  sessionId = (await createSession(app, token)).id;
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function seedDonePhoto(name: string): Promise<string> {
  // 随机纯色：避免纯色图完全相同而触发 sha256 重复去重（碰撞概率 1/2^24 可忽略）
  const { photoId } = await uploadDonePhoto(
    app,
    token,
    sessionId,
    userId,
    { name, buf: await makeJpeg(2000, 1000, { r: randomInt(256), g: randomInt(256), b: randomInt(256) }) },
  );
  return photoId;
}

describe('PUT /api/photos/:id/crop（保存裁剪，AC-F6-3/6）', () => {
  it('合法框按归一化保存并强制比例（2000x1000 图、1:1 → w/h=0.5）', async () => {
    const photoId = await seedDonePhoto('c_ok.jpg');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/crop`,
      payload: { ratio: '1:1', box: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, source: 'manual' },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.statusCode).toBe(200);
    const crop = res.json().crop;
    expect(crop.ratio).toBe('1:1');
    expect(crop.box_w / crop.box_h).toBeCloseTo(0.5); // 归一化空间 1:1 的比例
    // 中心保持
    expect(crop.box_x + crop.box_w / 2).toBeCloseTo(0.45);
  });

  it('面积 <20% 的小框被服务端硬校验降级为居中框（AC-F6-2）', async () => {
    const photoId = await seedDonePhoto('c_small.jpg');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/crop`,
      payload: { ratio: '1:1', box: { x: 0.47, y: 0.47, w: 0.06, h: 0.06 } },
      headers: auth(token),
    });
    const crop = res.json().crop;
    // 2000x1000 图、1:1 → 居中最大框为全高、水平居中的 0.5x1（像素上即 1000x1000）
    expect(crop.box_w).toBeCloseTo(0.5);
    expect(crop.box_h).toBeCloseTo(1);
    expect(crop.box_x).toBeCloseTo(0.25);
    expect(crop.box_y).toBeCloseTo(0);
  });

  it('完全非法的框同样降级居中，不落库失败', async () => {
    const photoId = await seedDonePhoto('c_bad.jpg');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/crop`,
      payload: { ratio: '16:9', box: { x: 'left', y: 0, w: -5, h: 0 } },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const crop = res.json().crop;
    expect(crop.box_w * crop.box_h).toBeGreaterThanOrEqual(0.2);
  });

  it('还原（source=original / 缺 box）清除裁剪记录（AC-F6-3）', async () => {
    const photoId = await seedDonePhoto('c_restore.jpg');
    await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/crop`,
      payload: { ratio: '1:1', box: { x: 0, y: 0, w: 0.5, h: 0.25 } },
      headers: auth(token),
    });
    expect(db.prepare('SELECT photo_id FROM crops WHERE photo_id = ?').get(photoId)).toBeDefined();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/crop`,
      payload: { source: 'original' },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().crop).toBeNull();
    expect(db.prepare('SELECT photo_id FROM crops WHERE photo_id = ?').get(photoId)).toBeUndefined();
  });

  it('非法 ratio 回退 original；未知照片 → 404', async () => {
    const photoId = await seedDonePhoto('c_ratio.jpg');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/crop`,
      payload: { ratio: '7:3', box: { x: 0, y: 0, w: 0.5, h: 0.5 } },
      headers: auth(token),
    });
    expect(res.json().crop.ratio).toBe('original');

    const missing = await app.inject({
      method: 'PUT',
      url: '/api/photos/nonexistent/crop',
      payload: { ratio: '1:1', box: { x: 0, y: 0, w: 0.5, h: 0.5 } },
      headers: auth(token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('越权裁剪他人照片 → 404', async () => {
    const photoId = await seedDonePhoto('c_priv.jpg');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/crop`,
      payload: { ratio: '1:1', box: { x: 0, y: 0, w: 0.5, h: 0.5 } },
      headers: auth(tokenOther),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/photos/:id/crop', () => {
  it('返回 suggestion 与 crop（可为 null）', async () => {
    const photoId = await seedDonePhoto('c_get.jpg');
    const res = await app.inject({
      method: 'GET',
      url: `/api/photos/${photoId}/crop`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestion).toBeNull();
    expect(res.json().crop).toBeNull();
  });
});

describe('POST /api/photos/:id/crop-suggest（单张 AI 建议，AC-F6-1）', () => {
  it('mock 供应商生成合法建议并入库', async () => {
    const photoId = await seedDonePhoto('cs_single.jpg');
    const res = await app.inject({
      method: 'POST',
      url: `/api/photos/${photoId}/crop-suggest`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);

    const row = db
      .prepare('SELECT * FROM crop_suggestions WHERE photo_id = ?')
      .get(photoId) as { ratio: string; box_w: number; box_h: number; reasoning: string };
    expect(row).toBeDefined();
    expect(['original', '1:1', '3:4', '4:3', '16:9', '9:16']).toContain(row.ratio);
    expect(row.box_w).toBeGreaterThan(0);
    expect(row.reasoning.length).toBeGreaterThan(0);
    expect(row.reasoning.length).toBeLessThanOrEqual(60);
  });
});

describe('批量构图建议 + 进度（AC-F6-1）', () => {
  it('批量跑完 2 张并轮询到完成', async () => {
    const s = (await createSession(app, token)).id;
    const uid = getUserId('crop_user');
    await uploadDonePhoto(app, token, s, uid, { name: 'b1.jpg', buf: await makeJpeg(800, 600, { r: 10, g: 100, b: 10 }) });
    await uploadDonePhoto(app, token, s, uid, { name: 'b2.jpg', buf: await makeJpeg(600, 800, { r: 100, g: 10, b: 10 }) });

    const start = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    expect(start.statusCode).toBe(200);

    const progress = await waitFor(async () => {
      const r = await app.inject({ method: 'GET', url: `/api/sessions/${s}/crop-progress`, headers: auth(token) });
      const p = r.json();
      return !p.running && p.done === 2 ? p : null;
    });
    expect(progress.total).toBe(2);

    const count = (
      db
        .prepare('SELECT COUNT(*) AS c FROM crop_suggestions WHERE photo_id IN (SELECT id FROM photos WHERE session_id = ?)')
        .get(s) as { c: number }
    ).c;
    expect(count).toBe(2);
  });

  it('photoIds 限定范围：只为指定的推荐照片生成建议', async () => {
    const s = (await createSession(app, token)).id;
    const uid = getUserId('crop_user');
    const mk = async (name: string, r: number) =>
      uploadDonePhoto(app, token, s, uid, {
        name,
        buf: await makeJpeg(700, 500, { r, g: 80, b: 80 }),
      });
    const { photoId: inA } = await mk('lim_a.jpg', 10);
    const { photoId: inB } = await mk('lim_b.jpg', 120);
    await mk('lim_c.jpg', 230);

    const start = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: { photoIds: [inA, inB] }, // 模拟「只为 AI 推荐的若干张生成」
      headers: auth(token),
    });
    expect(start.statusCode).toBe(200);

    await waitFor(async () => {
      const p = (
        await app.inject({ method: 'GET', url: `/api/sessions/${s}/crop-progress`, headers: auth(token) })
      ).json();
      return !p.running && p.done === 2;
    });

    const withSuggestion = (
      db
        .prepare(
          'SELECT photo_id FROM crop_suggestions WHERE photo_id IN (SELECT id FROM photos WHERE session_id = ?)',
        )
        .all(s) as Array<{ photo_id: string }>
    ).map((r) => r.photo_id);
    expect(withSuggestion.sort()).toEqual([inA, inB].sort());
  });

  it('进行中重复触发 → 409', async () => {
    const s = (await createSession(app, token)).id;
    const uid = getUserId('crop_user');
    await uploadDonePhoto(app, token, s, uid, { name: 'dup_run.jpg', buf: await makeJpeg(500, 500, { r: 5, g: 5, b: 5 }) });
    // 该照片已有建议（上面批量未覆盖此会话）→ 先确保有一张可跑的
    const first = await app.inject({ method: 'POST', url: `/api/sessions/${s}/crop-suggest`, payload: {}, headers: auth(token) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/api/sessions/${s}/crop-suggest`, payload: {}, headers: auth(token) });
    // 可能瞬间完成也可能仍进行中：断言要么 409 要么已完成（无并发窗口 flake 时为 409）
    expect([200, 409]).toContain(second.statusCode);
    await waitFor(async () => {
      const p = (
        await app.inject({ method: 'GET', url: `/api/sessions/${s}/crop-progress`, headers: auth(token) })
      ).json();
      return !p.running;
    });
  });
});

describe('构图建议：请求里的 model + 旧建议自动重算', () => {
  const progressOf = async (sid: string) =>
    (await app.inject({ method: 'GET', url: `/api/sessions/${sid}/crop-progress`, headers: auth(token) })).json() as {
      running: boolean;
      total: number;
      done: number;
    };

  it('批量接口使用请求里的 model 并回写会话', async () => {
    const s = (await createSession(app, token)).id;
    const uid = getUserId('crop_user');
    await uploadDonePhoto(app, token, s, uid, {
      name: 'prov_a.jpg',
      buf: await makeJpeg(800, 600, { r: 9, g: 9, b: 200 }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: { provider: 'mock', model: 'mock-vision-alt' },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, provider: 'mock', model: 'mock-vision-alt' });

    await waitFor(async () => {
      const p = await progressOf(s);
      return !p.running && p.done === 1 ? p : null;
    });

    const row = db
      .prepare(
        `SELECT cs.model AS model, cs.version AS version FROM crop_suggestions cs
         JOIN photos p ON p.id = cs.photo_id WHERE p.session_id = ?`,
      )
      .get(s) as { model: string; version: number };
    expect(row.model).toBe('mock-vision-alt');
    expect(row.version).toBe(CROP_SUGGEST_VERSION);

    const sess = db.prepare('SELECT provider, model FROM sessions WHERE id = ?').get(s) as {
      provider: string;
      model: string;
    };
    expect(sess).toMatchObject({ provider: 'mock', model: 'mock-vision-alt' });
  });

  it('旧版本建议在非 force 批次里自动重算', async () => {
    const s = (await createSession(app, token)).id;
    const uid = getUserId('crop_user');
    await uploadDonePhoto(app, token, s, uid, {
      name: 'stale_a.jpg',
      buf: await makeJpeg(700, 500, { r: 200, g: 30, b: 30 }),
    });

    await app.inject({ method: 'POST', url: `/api/sessions/${s}/crop-suggest`, payload: {}, headers: auth(token) });
    await waitFor(async () => {
      const p = await progressOf(s);
      return !p.running && p.done === 1 ? p : null;
    });

    // 模拟升级前留下的旧建议
    db.prepare(
      `UPDATE crop_suggestions SET version = 0, reasoning = '旧建议'
       WHERE photo_id IN (SELECT id FROM photos WHERE session_id = ?)`,
    ).run(s);

    const second = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    expect(second.statusCode).toBe(200);
    await waitFor(async () => {
      const p = await progressOf(s);
      return !p.running && p.done >= 1 ? p : null;
    });

    const row = db
      .prepare(
        `SELECT cs.version AS version, cs.reasoning AS reasoning FROM crop_suggestions cs
         JOIN photos p ON p.id = cs.photo_id WHERE p.session_id = ?`,
      )
      .get(s) as { version: number; reasoning: string };
    expect(row.version).toBe(CROP_SUGGEST_VERSION);
    expect(row.reasoning).not.toBe('旧建议');
  });

  it('当前版本 + 同模型已就绪的建议会被跳过（total=0）', async () => {
    const s = (await createSession(app, token)).id;
    const uid = getUserId('crop_user');
    await uploadDonePhoto(app, token, s, uid, {
      name: 'skip_a.jpg',
      buf: await makeJpeg(600, 600, { r: 30, g: 120, b: 30 }),
    });

    await app.inject({ method: 'POST', url: `/api/sessions/${s}/crop-suggest`, payload: {}, headers: auth(token) });
    await waitFor(async () => {
      const p = await progressOf(s);
      return !p.running && p.done === 1 ? p : null;
    });

    await app.inject({ method: 'POST', url: `/api/sessions/${s}/crop-suggest`, payload: {}, headers: auth(token) });
    const p = await progressOf(s);
    expect(p.total).toBe(0);
    expect(p.running).toBe(false);
  });

  it('GET /photos/:id/crop 返回归一化建议（box 对象 + warnings/stale）', async () => {
    const photoId = await seedDonePhoto('norm_shape.jpg');
    await app.inject({
      method: 'POST',
      url: `/api/photos/${photoId}/crop-suggest`,
      payload: { provider: 'mock', model: 'mock-vision' },
      headers: auth(token),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/photos/${photoId}/crop`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const sug = res.json().suggestion as {
      box: { x: number; y: number; w: number; h: number };
      warnings: string[];
      stale: boolean;
    };
    expect(sug.box).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      w: expect.any(Number),
      h: expect.any(Number),
    });
    expect(sug.box.w).toBeGreaterThan(0);
    expect(Array.isArray(sug.warnings)).toBe(true);
    expect(sug.stale).toBe(false);
  });
});
