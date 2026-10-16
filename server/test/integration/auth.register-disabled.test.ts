/**
 * REGISTER_ENABLED=false 时注册关闭（403）。
 * config 在模块加载时读取环境变量：env 副作用模块必须先于 helpers（→ config.ts）求值，
 * 因此它被声明在最前面。
 */
import '../fixtures/register-disabled.env.js';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, register, type App } from '../helpers.js';

let app: App;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
});

afterAll(async () => {
  await app.close();
});

describe('REGISTER_ENABLED=false（关闭注册）', () => {
  it('config 接口如实反映开关', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(res.json().registerEnabled).toBe(false);
  });

  it('注册被拒绝 → 403 注册已关闭', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'late_user', password: 'passw0rd1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('注册已关闭');
  });

  it('已有账号登录不受影响', async () => {
    // register 虽被 API 拒绝，但直接写入一条用户模拟存量账号
    const { db } = await import('../../src/db.js');
    const { hashSync } = await import('bcryptjs');
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      'legacy_user',
      hashSync('passw0rd1', 10),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'legacy_user', password: 'passw0rd1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });
});

// 保证静态导入的 register 在关闭注册语义下不可用（文档化意图，防止误用）
describe('静态 register helper 在本文件语境下预期失败', () => {
  it('register() 抛错', async () => {
    await expect(register(app, 'should_fail')).rejects.toThrow('register failed');
  });
});
