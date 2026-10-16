import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { httpErr } from '../util.js';
import { getProvider } from './providers/registry.js';
import { AnalysisSchema } from './schema.js';
import { photoDir } from './storage.js';
import { recordUsage } from './usage.js';

const cancelled = new Set<string>();
const running = new Set<string>();

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

export function requestCancel(sessionId: string): void {
  if (running.has(sessionId)) cancelled.add(sessionId);
}

export function startAnalysis(sessionId: string, providerId: string, model: string): void {
  if (running.has(sessionId)) throw httpErr(409, '该会话已有分析任务进行中');
  const sess = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessionId) as
    | { user_id: number }
    | undefined;
  if (!sess) throw httpErr(404, '会话不存在');
  running.add(sessionId);
  cancelled.delete(sessionId);
  void run(sessionId, sess.user_id, providerId, model).finally(() => running.delete(sessionId));
}

async function run(sessionId: string, userId: number, providerId: string, model: string): Promise<void> {
  const provider = getProvider(providerId);

  // 重新分析：清空旧结果，全部回到待分析
  db.prepare(`UPDATE photos SET status = 'ready', error = NULL WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM analyses WHERE photo_id IN (SELECT id FROM photos WHERE session_id = ?)`).run(sessionId);

  const photos = db
    .prepare('SELECT id FROM photos WHERE session_id = ? ORDER BY taken_at, created_at')
    .all(sessionId) as Array<{ id: string }>;

  // 全局并发闸（NFR-14）
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < photos.length) {
      if (cancelled.has(sessionId)) return;
      const photo = photos[cursor++];
      await analyzeOne(sessionId, userId, photo.id, provider, model);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.modelConcurrency, photos.length) }, worker));
}

async function analyzeOne(
  sessionId: string,
  userId: number,
  photoId: string,
  provider: ReturnType<typeof getProvider>,
  model: string,
): Promise<void> {
  db.prepare(`UPDATE photos SET status = 'analyzing', error = NULL WHERE id = ?`).run(photoId);
  try {
    const buf = await fs.readFile(path.join(photoDir(userId, sessionId, photoId), 'send.jpg'));
    const input = {
      imageBase64: buf.toString('base64'),
      mime: 'image/jpeg',
      model: model || provider.defaultModel,
    };

    let result = await provider.analyzePhoto({ ...input });
    let parsed = AnalysisSchema.safeParse(result.data);
    if (!parsed.success) {
      // AC-F3-4：非法输出带纠错指令重试一次
      result = await provider.analyzePhoto({
        ...input,
        corrective: '你上一次的输出不是合法 JSON 或字段取值不符合要求，请严格只输出符合约定的 JSON 对象。',
      });
      parsed = AnalysisSchema.safeParse(result.data);
    }
    if (!parsed.success) throw new Error('模型输出不符合约定格式');

    const a = parsed.data;
    db.prepare(
      `INSERT INTO analyses (photo_id, score, tags, issues, reason, raw, model)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(photoId, a.score, JSON.stringify(a.tags), JSON.stringify(a.issues), a.reason, input.model);
    db.prepare(`UPDATE photos SET status = 'done' WHERE id = ?`).run(photoId);
    recordUsage(sessionId, photoId, 'analysis', input.model, result.usage);
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 300);
    db.prepare(`UPDATE photos SET status = 'failed', error = ? WHERE id = ?`).run(message, photoId);
  }
}
