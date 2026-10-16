import { z } from 'zod';
import { db } from '../db.js';
import { httpErr } from '../util.js';
import { getProvider } from './providers/registry.js';
import { recordUsage } from './usage.js';
import type { CaptionStyle } from './providers/types.js';

const CaptionsResultSchema = z.array(z.coerce.string().min(1).max(500)).min(1).max(5);

export interface CaptionItem {
  style: string;
  text: string;
}

export function readCaptions(sessionId: string): CaptionItem[] | null {
  const row = db.prepare('SELECT items FROM captions WHERE session_id = ?').get(sessionId) as
    | { items: string }
    | undefined;
  return row ? (JSON.parse(row.items) as CaptionItem[]) : null;
}

/**
 * 生成朋友圈文案：聚合入选照片的标签/简评，仅文本调用（AC-F7-1~3）
 */
export async function generateCaptions(
  sessionId: string,
  userId: number,
  style: CaptionStyle,
  note: string | undefined,
  photoIds: string[] | undefined,
): Promise<CaptionItem[]> {
  const sess = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId) as
    | { id: string; provider: string; model: string | null }
    | undefined;
  if (!sess) throw httpErr(404, '会话不存在');

  let rows = db
    .prepare(
      `SELECT p.id, p.filename, a.tags, a.reason
       FROM photos p JOIN analyses a ON a.photo_id = p.id
       WHERE p.session_id = ? AND p.status = 'done'
       ORDER BY p.taken_at, p.created_at`,
    )
    .all(sessionId) as Array<{ id: string; filename: string; tags: string; reason: string }>;
  if (photoIds && photoIds.length > 0) {
    const ids = new Set(photoIds);
    rows = rows.filter((r) => ids.has(r.id));
  }
  if (rows.length === 0) throw httpErr(409, '没有已分析的照片，无法生成文案');

  // 标签按出现频次聚合（AC-F7-3 内容相关性来源）
  const freq = new Map<string, number>();
  for (const r of rows) for (const t of JSON.parse(r.tags) as string[]) freq.set(t, (freq.get(t) ?? 0) + 1);
  const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  const reasons = rows.slice(0, 5).map((r) => r.reason);

  const provider = getProvider(sess.provider);
  const input = {
    model: sess.model ?? provider.defaultModel,
    tags,
    reasons,
    style,
    note: note?.slice(0, 100) || undefined,
  };
  let res = await provider.generateCaptions({ ...input });
  if (!CaptionsResultSchema.safeParse(res.data).success) {
    res = await provider.generateCaptions({
      ...input,
      corrective: '你上一次的输出不是合法 JSON 或文案数量不对，请严格只输出符合约定的 JSON 对象。',
    });
  }
  const parsed = CaptionsResultSchema.safeParse(res.data);
  if (!parsed.success) throw httpErr(502, '文案生成失败，请重试');

  const styleOf = (i: number): string => (style === '混合' ? ['简洁', '文艺', '搞笑'][i % 3] : style);
  const items: CaptionItem[] = parsed.data.slice(0, 3).map((text, i) => ({ style: styleOf(i), text }));

  db.prepare(
    `INSERT INTO captions (session_id, items, note) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET items = excluded.items, note = excluded.note, updated_at = datetime('now')`,
  ).run(sessionId, JSON.stringify(items), input.note ?? null);
  recordUsage(sessionId, null, 'caption', input.model, res.usage);

  return items;
}

/** 用户编辑后保存（AC-F7-4） */
export function saveCaptions(sessionId: string, userId: number, items: CaptionItem[]): void {
  const owns = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!owns) throw httpErr(404, '会话不存在');
  const clean = items
    .filter((i) => i && typeof i.text === 'string' && i.text.trim())
    .slice(0, 9)
    .map((i) => ({ style: String(i.style ?? '自定义').slice(0, 10), text: i.text.trim() }));
  if (clean.length === 0) throw httpErr(400, '文案内容不能为空');
  db.prepare(
    `INSERT INTO captions (session_id, items, note) VALUES (?, ?, NULL)
     ON CONFLICT(session_id) DO UPDATE SET items = excluded.items, note = NULL, updated_at = datetime('now')`,
  ).run(sessionId, JSON.stringify(clean));
}
