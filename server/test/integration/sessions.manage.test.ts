import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  token = (await register(app, 'sess_user')).token;
  tokenOther = (await register(app, 'sess_other')).token;
  userId = getUserId('sess_user');
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('会话管理（列表 / 重命名 / 删除）', () => {
  it('GET /api/sessions 带 title 与 photoCount，按创建时间倒序', async () => {
    const s1 = (await createSession(app, token)).id;
    const s2 = (await createSession(app, token)).id;
    await uploadDonePhoto(app, token, s1, userId, {
      name: 'm1.jpg',
      buf: await makeJpeg(200, 200, { r: 1, g: 2, b: 3 }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const list = res.json().sessions as Array<{
      id: string;
      title: string | null;
      photoCount: number;
    }>;
    expect(list.map((s) => s.id)).toEqual([s2, s1]); // 新的在前
    expect(list.find((s) => s.id === s1)!.photoCount).toBe(1);
    expect(list.find((s) => s.id === s1)!.title).toBeNull();
  });

  it('PATCH 重命名后列表与详情都反映', async () => {
    const s = (await createSession(app, token)).id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${s}`,
      payload: { title: '三亚蜜月' },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('三亚蜜月');

    const detail = (
      await app.inject({ method: 'GET', url: `/api/sessions/${s}`, headers: auth(token) })
    ).json();
    expect(detail.session.title).toBe('三亚蜜月');
  });

  it('PATCH 超长标题被截断到 40 字', async () => {
    const s = (await createSession(app, token)).id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${s}`,
      payload: { title: 'x'.repeat(100) },
      headers: auth(token),
    });
    expect(res.json().title).toHaveLength(40);
  });

  it('DELETE 删除会话及其照片与构图任务记录', async () => {
    const s = (await createSession(app, token)).id;
    await uploadDonePhoto(app, token, s, userId, {
      name: 'del.jpg',
      buf: await makeJpeg(200, 200, { r: 5, g: 5, b: 5 }),
    });
    db.prepare(
      `INSERT INTO crop_jobs (session_id, total, done, cancelled, running) VALUES (?, 1, 1, 0, 0)`,
    ).run(s);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${s}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);

    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(s)).toBeUndefined();
    expect(db.prepare('SELECT id FROM photos WHERE session_id = ?').get(s)).toBeUndefined();
    // crop_jobs 通过外键级联删除
    expect(db.prepare('SELECT session_id FROM crop_jobs WHERE session_id = ?').get(s)).toBeUndefined();
  });

  it('越权重命名 / 删除 → 404', async () => {
    const s = (await createSession(app, token)).id;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${s}`,
      payload: { title: 'hacked' },
      headers: auth(tokenOther),
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${s}`,
      headers: auth(tokenOther),
    });
    expect(del.statusCode).toBe(404);
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(s)).toBeDefined();
  });
});
