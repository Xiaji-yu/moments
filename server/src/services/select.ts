import { db } from '../db.js';
import { httpErr } from '../util.js';
import { computeClusters } from './cluster.js';

export interface SelectedItem {
  order: number;
  photoId: string;
  filename: string;
  score: number;
  reason: string;
  tags: string[];
  issues: string[];
}

export interface RejectedItem {
  photoId: string;
  filename: string;
  score: number;
  category: '重复' | '质量问题' | '内容平淡';
  detail: string;
}

export function selectTopN(sessionId: string, n: number): { selected: SelectedItem[]; rejected: RejectedItem[] } {
  const pending = db
    .prepare(`SELECT COUNT(*) AS c FROM photos WHERE session_id = ? AND status != 'done'`)
    .get(sessionId) as { c: number };
  if (pending.c > 0) throw httpErr(409, '还有照片未完成分析，请稍后再试');

  const rows = db
    .prepare(
      `SELECT p.id, p.filename, a.score, a.tags, a.issues, a.reason
       FROM photos p JOIN analyses a ON a.photo_id = p.id
       WHERE p.session_id = ?`,
    )
    .all(sessionId) as Array<{
    id: string;
    filename: string;
    score: number;
    tags: string;
    issues: string;
    reason: string;
  }>;
  if (rows.length === 0) throw httpErr(409, '没有可推荐的照片');

  const { index } = computeClusters(sessionId);
  const sorted = [...rows].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  const used = new Set<number>();
  const chosenIds = new Set<string>();
  const selected: SelectedItem[] = [];
  for (const r of sorted) {
    if (selected.length >= n) break;
    const c = index.get(r.id)!;
    if (used.has(c)) continue; // AC-F5-3：同组最多入选 1 张
    used.add(c);
    chosenIds.add(r.id);
    selected.push({
      order: selected.length + 1,
      photoId: r.id,
      filename: r.filename,
      score: r.score,
      reason: r.reason,
      tags: JSON.parse(r.tags),
      issues: JSON.parse(r.issues),
    });
  }

  const rejected: RejectedItem[] = rows
    .filter((r) => !chosenIds.has(r.id))
    .sort((a, b) => b.score - a.score)
    .map((r) => {
      const c = index.get(r.id)!;
      const issues = JSON.parse(r.issues) as string[];
      let category: RejectedItem['category'] = '内容平淡';
      let detail = `评分 ${r.score} 分，内容吸引力一般`;
      if (used.has(c)) {
        category = '重复';
        detail = '同组相似照片已选择更优的一张';
      } else if (issues.length > 0) {
        category = '质量问题';
        detail = issues.join('、');
      }
      return { photoId: r.id, filename: r.filename, score: r.score, category, detail };
    });

  return { selected, rejected };
}
