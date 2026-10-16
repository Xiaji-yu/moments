import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, register, type App } from '../helpers.js';

let app: App;
let token: string;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'prov_user')).token;
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/providers（AC-F0-1：列表不含任何 Key）', () => {
  it('无 Key 环境只暴露 mock，且响应不含敏感字段', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    const { providers } = res.json();
    expect(providers.map((p: { id: string }) => p.id)).toEqual(['mock']);
    for (const p of providers) {
      expect(Object.keys(p).sort()).toEqual(['defaultModel', 'id', 'label', 'models']);
      expect(JSON.stringify(p)).not.toMatch(/key|secret/i);
    }
  });
});

describe('POST /api/providers/:id/test（AC-F0-2 连通性测试）', () => {
  it('mock 供应商测试通过并返回延迟', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/mock/test',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.model).toBe('mock-vision');
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('需要登录', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/providers/mock/test' });
    expect(res.statusCode).toBe(401);
  });

  it('不存在的供应商 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/nope/test',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
