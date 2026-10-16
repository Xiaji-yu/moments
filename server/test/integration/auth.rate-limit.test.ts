/**
 * 登录接口防爆破限速（AC-F11-2 / NFR）。
 * 独立文件：rate limit 按 IP 计数（1 分钟窗口），避免与其他用例互相占用额度。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, register, type App } from '../helpers.js';

let app: App;

beforeAll(async () => {
  app = (await makeApp()) as App;
  await register(app, 'rate_user');
});

afterAll(async () => {
  await app.close();
});

describe('登录限速（max 5 / 分钟）', () => {
  it('前 5 次错误密码返回 401，第 6 次被限流 429', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'rate_user', password: `wrongpass${i}` },
      });
      expect(res.statusCode, `第 ${i + 1} 次应仍为 401`).toBe(401);
    }
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'rate_user', password: 'wrongpass-again' },
    });
    expect(sixth.statusCode).toBe(429);
  });

  it('注册接口同样有限速（max 10 / 分钟）', async () => {
    let last = 200;
    let count = 0;
    while (last !== 429 && count < 15) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: `burst_${count}`, password: 'passw0rd1' },
      });
      last = res.statusCode;
      count++;
    }
    expect(last).toBe(429);
    expect(count).toBeLessThanOrEqual(11); // 前 10 次可用，第 11 次必被限
  });
});
