import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, makeApp, register, type App } from '../helpers.js';

let app: App;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  tokenA = (await register(app, 'sess_owner')).token;
  tokenB = (await register(app, 'sess_other')).token;
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('会话 CRUD 与数据隔离', () => {
  it('创建会话：无 Key 环境默认 mock 供应商', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: {}, headers: auth(tokenA) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toHaveLength(12);
    expect(body.provider).toBe('mock');
    expect(body.model).toBe('mock-vision');
  });

  it('未登录创建会话 → 401', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).statusCode).toBe(401);
  });

  it('列表只返回自己的会话', async () => {
    const s1 = await createSession(app, tokenA);
    await createSession(app, tokenB);
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth(tokenA) });
    const ids = (res.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(ids).toContain(s1.id);
    // B 的会话不应出现在 A 的列表（由用户隔离保证）
    const resB = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth(tokenB) });
    const idsB = (resB.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(idsB).not.toEqual(ids);
  });

  it('越权访问他人会话 → 404（AC-F11-5，不暴露存在性）', async () => {
    const s = await createSession(app, tokenA);
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.id}`, headers: auth(tokenB) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('会话不存在');
  });

  it('不存在的会话 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope12345678', headers: auth(tokenA) });
    expect(res.statusCode).toBe(404);
  });

  it('GET 会话详情返回空照片数组与 session 元信息', async () => {
    const s = await createSession(app, tokenA);
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.id}`, headers: auth(tokenA) });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.id).toBe(s.id);
    expect(res.json().photos).toEqual([]);
  });

  it('删除会话后不可再访问', async () => {
    const s = await createSession(app, tokenA);
    const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${s.id}`, headers: auth(tokenA) });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${s.id}`, headers: auth(tokenA) })).statusCode).toBe(404);
  });

  it('B 不能删除 A 的会话（越权 404）', async () => {
    const s = await createSession(app, tokenA);
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${s.id}`, headers: auth(tokenB) });
    expect(res.statusCode).toBe(404);
    // A 仍可访问
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${s.id}`, headers: auth(tokenA) })).statusCode).toBe(200);
  });
});
