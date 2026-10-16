import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { db } from '../../src/db.js';
import {
  createSession,
  getUserId,
  makeApp,
  makeJpeg,
  register,
  uploadDonePhoto,
  type App,
} from '../helpers.js';

let app: App;
let token: string;
let tokenOther: string;
let userId: number;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'grid_user')).token;
  tokenOther = (await register(app, 'grid_other')).token;
  userId = getUserId('grid_user');
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 造一个 N 张已完成照片的会话，返回 sessionId 与照片 id 列表 */
async function seedSession(count: number): Promise<{ s: string; ids: string[] }> {
  const s = (await createSession(app, token)).id;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { photoId } = await uploadDonePhoto(app, token, s, userId, {
      name: `g${i}.jpg`,
      buf: await makeJpeg(600, 400, { r: 20 * i, g: 30, b: 200 }),
    });
    db.prepare(
      'INSERT INTO analyses (photo_id, score, tags, issues, reason) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, 7, '[]', '[]', '不错');
    ids.push(photoId);
  }
  return { s, ids };
}

describe('POST /api/sessions/:id/export-grid（九宫格拼图导出）', () => {
  it('3 张图 + cols=3 → 单行 3 列，尺寸符合 cell/gap', async () => {
    const { s, ids } = await seedSession(3);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export-grid`,
      payload: { photoIds: ids, cols: 3, cell: 200, gap: 10 },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toContain('moments-grid-');

    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(3 * 200 + 2 * 10);
    expect(meta.height).toBe(200); // 只有一行
  });

  it('4 张图 + cols=2 → 2×2 网格', async () => {
    const { s, ids } = await seedSession(4);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export-grid`,
      payload: { photoIds: ids, cols: 2, cell: 150, gap: 0 },
      headers: auth(token),
    });
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(300);
  });

  it('1 张图 + cols=1 → 单格', async () => {
    const { s, ids } = await seedSession(1);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export-grid`,
      payload: { photoIds: ids, cols: 1, cell: 320 },
      headers: auth(token),
    });
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(320);
  });

  it('不传 photoIds 时按拍摄时间导出全部已完成照片', async () => {
    const { s } = await seedSession(2);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export-grid`,
      payload: { cols: 2, cell: 100 },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(2 * 100 + 8); // 2 列 + 1 个默认 gap(8)
    expect(meta.height).toBe(100); // 1 行
  });

  it('没有可导出照片 → 409', async () => {
    const s = (await createSession(app, token)).id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export-grid`,
      payload: {},
      headers: auth(token),
    });
    expect(res.statusCode).toBe(409);
  });

  it('越权导出 → 404', async () => {
    const { s } = await seedSession(1);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export-grid`,
      payload: {},
      headers: auth(tokenOther),
    });
    expect(res.statusCode).toBe(404);
  });
});
