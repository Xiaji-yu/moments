import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSession,
  getUserId,
  insertAnalysisRow,
  insertPhotoRow,
  insertSessionRow,
  makeApp,
  register,
  type App,
} from '../helpers.js';

let app: App;
let token: string;
let tokenOther: string;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'cap_user')).token;
  tokenOther = (await register(app, 'cap_other')).token;
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 造一个已分析完成的会话：2 张照片、标签频次 2:1 */
async function seedAnalyzedSession(id: string, ownerToken: string): Promise<void> {
  const userId = getUserId(ownerToken === token ? 'cap_user' : 'cap_other');
  insertSessionRow(id, userId);
  insertPhotoRow({ id: `${id}_p1`, sessionId: id, userId, phash: 'aa01', takenAt: '2024-05-01T08:00:00Z', hasExif: true });
  insertPhotoRow({ id: `${id}_p2`, sessionId: id, userId, phash: 'aa02', takenAt: '2024-05-01T08:01:00Z', hasExif: true });
  insertAnalysisRow(`${id}_p1`, { score: 9, tags: ['海边', '日落'], reason: '光线好' });
  insertAnalysisRow(`${id}_p2`, { score: 8, tags: ['海边'], reason: '构图稳' });
}

beforeAll(async () => {
  await seedAnalyzedSession('cap_ok', token);
  await seedAnalyzedSession('cap_other_s', tokenOther);
});

describe('POST /api/sessions/:id/caption（AI 文案，AC-F7）', () => {
  it('混合风格返回 3 条候选，风格循环标注，并持久化', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/cap_ok/caption',
      payload: { style: '混合' },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(3);
    expect(items.map((i: { style: string }) => i.style)).toEqual(['简洁', '文艺', '搞笑']);
    for (const i of items) {
      expect(i.text.trim().length).toBeGreaterThan(0);
    }

    // 已保存
    const get = await app.inject({ method: 'GET', url: '/api/sessions/cap_ok/caption', headers: auth(token) });
    expect((get.json() as { items: unknown[] }).items).toHaveLength(3);
  });

  it('指定单一风格时三条候选同风格；note 传入不报错', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/cap_ok/caption',
      payload: { style: '搞笑', note: '海边一日游' },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    for (const i of res.json().items as Array<{ style: string }>) {
      expect(i.style).toBe('搞笑');
    }
  });

  it('photoIds 过滤生效（只用指定照片的标签）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/cap_ok/caption',
      payload: { photoIds: ['cap_ok_p2'] },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
  });

  it('没有已分析照片 → 409', async () => {
    const userId = getUserId('cap_user');
    insertSessionRow('cap_empty', userId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/cap_empty/caption',
      payload: {},
      headers: auth(token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('没有已分析的照片');
  });

  it('未保存过文案时 GET 返回 null', async () => {
    const userId = getUserId('cap_user');
    insertSessionRow('cap_null', userId);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/cap_null/caption', headers: auth(token) });
    expect(res.json().items).toBeNull();
  });

  it('越权生成他人会话文案 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/cap_ok/caption',
      payload: {},
      headers: auth(tokenOther),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/sessions/:id/caption（编辑保存，AC-F7-4）', () => {
  it('保存后可读回；空白条目被过滤', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sessions/cap_ok/caption',
      payload: { items: [{ style: '自定义', text: '  手写第一条  ' }, { style: '自定义', text: '   ' }] },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ style: string; text: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('手写第一条');

    const get = await app.inject({ method: 'GET', url: '/api/sessions/cap_ok/caption', headers: auth(token) });
    expect((get.json() as { items: Array<{ text: string }> }).items[0].text).toBe('手写第一条');
  });

  it('最多保存 9 条，style 截断 10 字', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ style: '很长的风格名称'.repeat(3), text: `第${i}条` }));
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sessions/cap_ok/caption',
      payload: { items },
      headers: auth(token),
    });
    const saved = res.json().items as Array<{ style: string; text: string }>;
    expect(saved.length).toBeLessThanOrEqual(9);
    expect(saved[0].style.length).toBeLessThanOrEqual(10);
  });

  it('全部为空 → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sessions/cap_ok/caption',
      payload: { items: [{ style: 'x', text: '' }] },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('文案内容不能为空');
  });

  it('items 非数组 → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sessions/cap_ok/caption',
      payload: { items: 'bad' },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(400);
  });
});
