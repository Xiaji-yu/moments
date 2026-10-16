import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db.js';
import { assertQuota, todayTokens } from '../../src/services/quota.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 造一个「今日已消耗 tokens」的用户 */
function seedUserWithTokens(userId: number, tokens: number): void {
  db.prepare('INSERT OR REPLACE INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
    userId,
    `quota_u_${userId}`,
    'h',
  );
  db.prepare('INSERT OR REPLACE INTO sessions (id, user_id) VALUES (?, ?)').run(`quota_s_${userId}`, userId);
  db.prepare(
    'INSERT INTO model_usage (session_id, kind, input_tokens, output_tokens) VALUES (?, ?, ?, ?)',
  ).run(`quota_s_${userId}`, 'analysis', Math.floor(tokens / 2), tokens - Math.floor(tokens / 2));
}

describe('todayTokens', () => {
  it('无记录时为 0', () => {
    expect(todayTokens(999_999)).toBe(0);
  });

  it('汇总该用户今日全部调用的 input + output', () => {
    seedUserWithTokens(9001, 300);
    expect(todayTokens(9001)).toBe(300);
  });
});

describe('assertQuota（防烧 Key 的日配额）', () => {
  it('未配置 / 配 0 时不限制', () => {
    vi.stubEnv('DAILY_TOKEN_LIMIT', '0');
    seedUserWithTokens(9010, 10_000);
    expect(() => assertQuota(9010)).not.toThrow();
  });

  it('未达上限时放行', () => {
    vi.stubEnv('DAILY_TOKEN_LIMIT', '1000');
    seedUserWithTokens(9011, 900);
    expect(() => assertQuota(9011)).not.toThrow();
  });

  it('达到上限后抛 429，消息含已用与限额', () => {
    vi.stubEnv('DAILY_TOKEN_LIMIT', '500');
    seedUserWithTokens(9012, 600);
    try {
      assertQuota(9012);
      expect.unreachable('应当抛出 429');
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(429);
      expect((err as Error).message).toContain('600');
      expect((err as Error).message).toContain('500');
    }
  });
});
