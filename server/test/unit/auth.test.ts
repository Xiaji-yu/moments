import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { requireAuth, signToken, type AuthUser } from '../../src/auth.js';
import { config } from '../../src/config.js';
import { httpErr } from '../../src/util.js';

const user: AuthUser = { id: 42, username: 'alice' };

const reqWith = (authorization?: string) =>
  ({ headers: { authorization } }) as Parameters<typeof requireAuth>[0];

const expectStatus = (fn: () => unknown, status: number) => {
  try {
    fn();
    expect.unreachable('should have thrown');
  } catch (err) {
    expect((err as { statusCode?: number }).statusCode).toBe(status);
  }
};

describe('signToken / requireAuth（JWT 鉴权）', () => {
  it('签发的 token 可被 requireAuth 解析出用户', () => {
    const token = signToken(user);
    const payload = jwt.decode(token) as { sub: number; username: string };
    expect(Number(payload.sub)).toBe(42);
    expect(payload.username).toBe('alice');

    const req = reqWith(`Bearer ${token}`);
    requireAuth(req);
    expect(req.user).toEqual({ id: 42, username: 'alice' });
  });

  it('无 Authorization 头 → 401 未登录', () => {
    expectStatus(() => requireAuth(reqWith(undefined)), 401);
    expectStatus(() => requireAuth(reqWith('Basic abc')), 401);
  });

  it('伪造/篡改的 token → 401', () => {
    const forged = jwt.sign({ sub: 1, username: 'x' }, 'wrong-secret', { expiresIn: '7d' });
    try {
      requireAuth(reqWith(`Bearer ${forged}`));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe('登录已过期，请重新登录');
    }
  });

  it('过期 token → 401', () => {
    const expired = jwt.sign({ sub: 1, username: 'x' }, config.jwtSecret, { expiresIn: -10 });
    expectStatus(() => requireAuth(reqWith(`Bearer ${expired}`)), 401);
  });

  it('httpErr 产物带正确状态码（配合鉴权语义）', () => {
    expect(httpErr(401, '未登录').statusCode).toBe(401);
  });
});
