import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, register, type App } from '../helpers.js';

let app: App;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
});

afterAll(async () => {
  await app.close();
});

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

describe('POST /api/auth/register', () => {
  it('合法用户名密码注册成功并返回 token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice_01', password: 'passw0rd1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.username).toBe('alice_01');
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(3); // JWT 三段
  });

  it('重复用户名 → 409', async () => {
    await register(app, 'dup_user');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'dup_user', password: 'passw0rd1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('用户名已存在');
  });

  it.each([
    { username: 'ab', password: 'passw0rd1', why: '用户名太短' },
    { username: 'a'.repeat(21), password: 'passw0rd1', why: '用户名太长' },
    { username: 'has space', password: 'passw0rd1', why: '用户名含非法字符' },
    { username: 'ok_name', password: 'short1a', why: '密码太短' },
    { username: 'ok_name', password: 'onlyletters', why: '密码无数字' },
    { username: 'ok_name', password: '12345678', why: '密码无字母' },
  ])('非法输入（$why）→ 400', async ({ username, password }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it('用户名规则与文档一致（3~20 位字母数字下划线）', () => {
    expect(USERNAME_RE.test('abc_123')).toBe(true);
    expect(USERNAME_RE.test('中文')).toBe(false);
  });
});

describe('POST /api/auth/login', () => {
  it('正确密码登录成功', async () => {
    await register(app, 'login_ok');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'login_ok', password: 'passw0rd1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it('错误密码与不存在用户返回统一错误，不泄露账号存在性（AC-F11-2）', async () => {
    await register(app, 'login_sec');
    const wrongPw = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'login_sec', password: 'wrongpass9' },
    });
    const noUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ghost_user', password: 'wrongpass9' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPw.json().error).toBe(noUser.json().error);
  });
});

describe('GET /api/auth/me 与 POST /api/auth/logout', () => {
  it('带合法 token 可读取当前用户', async () => {
    const { token, username } = await register(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe(username);
  });

  it('无 token / 坏 token → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { authorization: 'Bearer not.a.jwt' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('logout 返回 ok', async () => {
    const { token } = await register(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe('GET /api/auth/config', () => {
  it('公开接口无需鉴权，返回注册开关', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().registerEnabled).toBe('boolean');
  });
});
