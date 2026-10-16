import type { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db.js';
import { httpErr } from '../util.js';

/** 每用户每日 token 配额；0 或未配置 = 不限制。运行时读 env（与 usage.ts 的单价一致，便于测试 stub） */
function dailyLimit(): number {
  return Math.max(0, Number(process.env.DAILY_TOKEN_LIMIT ?? 0));
}

/** 该用户今日（UTC）已消耗的 token 总数 */
export function todayTokens(userId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS tokens
       FROM model_usage m JOIN sessions s ON s.id = m.session_id
       WHERE s.user_id = ? AND m.created_at >= datetime('now', 'start of day')`,
    )
    .get(userId) as { tokens: number };
  return row.tokens;
}

/** 未超配额时静默通过；超了抛 429 */
export function assertQuota(userId: number): void {
  const limit = dailyLimit();
  if (limit <= 0) return;
  const used = todayTokens(userId);
  if (used >= limit) {
    throw httpErr(429, `今日模型额度已用完（已用 ${used} / ${limit} tokens），请明天再试`);
  }
}

/** 与 authPreHandler 同样式的前置守卫，只挂在「会花 Key」的路由上 */
export const quotaGuard = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  if (req.user) assertQuota(req.user.id);
};
