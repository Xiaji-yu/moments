import { db } from '../db.js';
import { hammingHex } from './images.js';

export interface ClusterIndex {
  /** photoId -> 组 id（组 id 为成员行号的最大根） */
  index: Map<string, number>;
  /** 组 id -> 成员 photoId 列表 */
  groups: Map<number, string[]>;
}

/**
 * 相似照聚类：
 * - 双方都有 EXIF 拍摄时间且间隔 <= 2 秒（连拍）归为一组
 * - 或 pHash 汉明距离 <= 8（画面高度相似）归为一组（兜底无 EXIF 的照片）
 * 纯本地计算，不产生模型调用（AC-F4-1）
 */
export function computeClusters(sessionId: string): ClusterIndex {
  const rows = db
    .prepare('SELECT id, phash, taken_at, has_exif FROM photos WHERE session_id = ?')
    .all(sessionId) as Array<{ id: string; phash: string; taken_at: string; has_exif: number }>;

  const parent = rows.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const A = rows[i];
      const B = rows[j];
      let same = false;
      if (A.has_exif && B.has_exif && A.taken_at && B.taken_at) {
        if (Math.abs(new Date(A.taken_at).getTime() - new Date(B.taken_at).getTime()) <= 2000) same = true;
      }
      if (!same && A.phash && B.phash && hammingHex(A.phash, B.phash) <= 8) same = true;
      if (same) union(i, j);
    }
  }

  const index = new Map<string, number>();
  const groups = new Map<number, string[]>();
  rows.forEach((r, i) => {
    const root = find(i);
    index.set(r.id, root);
    const arr = groups.get(root);
    if (arr) arr.push(r.id);
    else groups.set(root, [r.id]);
  });
  return { index, groups };
}
