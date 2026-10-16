import { db } from '../db.js';
import type { TokenUsage } from './providers/types.js';

export type UsageKind = 'analysis' | 'crop' | 'caption';

export function recordUsage(
  sessionId: string,
  photoId: string | null,
  kind: UsageKind,
  model: string,
  usage?: TokenUsage,
): void {
  if (!usage || (!usage.input && !usage.output)) return;
  db.prepare(
    `INSERT INTO model_usage (session_id, photo_id, kind, model, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, photoId, kind, model, usage.input ?? 0, usage.output ?? 0);
}

export interface UsageSummary {
  calls: number;
  input: number;
  output: number;
  /** 配置了单价（COST_PER_1M_*）才估算，单位：元 */
  costEstimate: number | null;
}

export function getSessionUsage(sessionId: string): UsageSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output
       FROM model_usage WHERE session_id = ?`,
    )
    .get(sessionId) as { calls: number; input: number; output: number };

  const pin = Number(process.env.COST_PER_1M_INPUT ?? '');
  const pout = Number(process.env.COST_PER_1M_OUTPUT ?? '');
  const costEstimate =
    Number.isFinite(pin) && Number.isFinite(pout) && process.env.COST_PER_1M_INPUT && process.env.COST_PER_1M_OUTPUT
      ? (row.input / 1_000_000) * pin + (row.output / 1_000_000) * pout
      : null;

  return { calls: row.calls, input: row.input, output: row.output, costEstimate };
}
