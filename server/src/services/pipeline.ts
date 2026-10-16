import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { httpErr, userFacingError } from '../util.js';
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

export interface AnalyzeOptions {
  /** 只分析这些照片（单张/批量重试）；缺省为会话内全部 */
  photoIds?: string[];
  /** 只分析未完成的（status != 'done'），已完成的跳过 */
  onlyPending?: boolean;
}

export function startAnalysis(
  sessionId: string,
  providerId: string,
  model: string,
  opts: AnalyzeOptions = {},
): void {
  if (running.has(sessionId)) throw httpErr(409, '该会话已有分析任务进行中');
  const sess = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessionId) as
    | { user_id: number }
    | undefined;
  if (!sess) throw httpErr(404, '会话不存在');

  // 目标照片与 provider 都在启动前同步确定：校验失败可直接作为 HTTP 错误返回给调用方，
  // 而不是抛进后台任务里变成 unhandled rejection。
  const provider = getProvider(providerId);
  const photos = pickPhotos(sessionId, opts);

  running.add(sessionId);
  cancelled.delete(sessionId);
  void run(sessionId, sess.user_id, provider, model, photos)
    .finally(() => running.delete(sessionId))
    .catch((err) => console.error('[analysis] 后台任务异常', err));
}

/** 按 opts 计算本次要分析的照片；无目标时抛 400（同步，便于路由返回） */
function pickPhotos(sessionId: string, opts: AnalyzeOptions): PhotoRow[] {
  const all = db
    .prepare('SELECT id, filename, width, height, status FROM photos WHERE session_id = ? ORDER BY taken_at, created_at')
    .all(sessionId) as PhotoRow[];

  if (opts.photoIds && opts.photoIds.length > 0) {
    const ids = new Set(opts.photoIds);
    const photos = all.filter((p) => ids.has(p.id));
    if (photos.length === 0) throw httpErr(400, '没有需要分析的照片');
    return photos;
  }
  if (opts.onlyPending) {
    const photos = all.filter((p) => p.status !== 'done');
    if (photos.length === 0) throw httpErr(400, '没有需要重试的照片，全部照片均已完成分析');
    return photos;
  }
  return all;
}

async function run(
  sessionId: string,
  userId: number,
  provider: ReturnType<typeof getProvider>,
  model: string,
  photos: PhotoRow[],
): Promise<void> {
  // 重新分析：只清理本次目标的旧结果（增量模式下已完成的照片与其分析不受影响）
  const ids = photos.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE photos SET status = 'ready', error = NULL WHERE id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM analyses WHERE photo_id IN (${placeholders})`).run(...ids);

  // 全局并发闸（NFR-14）
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < photos.length) {
      if (cancelled.has(sessionId)) return;
      const photo = photos[cursor++];
      await analyzeOne(sessionId, userId, photo.id, provider, model, photo);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.modelConcurrency, photos.length) }, worker));
}

interface PhotoRow {
  id: string;
  filename: string;
  width: number;
  height: number;
  status: string;
}

/**
 * 单张重试：路由同步等待并返回结果（比整会话重跑更符合「就这张失败了」的场景）。
 * 与全量分析互斥：会话已有分析任务时返回 409。
 */
export async function retryOne(
  sessionId: string,
  userId: number,
  photoId: string,
  providerId: string,
  model: string,
): Promise<{ status: string; error: string | null }> {
  if (running.has(sessionId)) throw httpErr(409, '该会话已有分析任务进行中，请稍后再试');
  const photo = db
    .prepare('SELECT id, filename, width, height, status FROM photos WHERE id = ? AND session_id = ?')
    .get(photoId, sessionId) as PhotoRow | undefined;
  if (!photo) throw httpErr(404, '照片不存在');

  const provider = getProvider(providerId);
  db.prepare(`UPDATE photos SET status = 'ready', error = NULL WHERE id = ?`).run(photoId);
  db.prepare(`DELETE FROM analyses WHERE photo_id = ?`).run(photoId);
  await analyzeOne(sessionId, userId, photoId, provider, model, photo);

  const row = db.prepare('SELECT status, error FROM photos WHERE id = ?').get(photoId) as {
    status: string;
    error: string | null;
  };
  return row;
}

async function analyzeOne(
  sessionId: string,
  userId: number,
  photoId: string,
  provider: ReturnType<typeof getProvider>,
  model: string,
  photo: { filename: string; width: number; height: number },
): Promise<void> {
  db.prepare(`UPDATE photos SET status = 'analyzing', error = NULL WHERE id = ?`).run(photoId);
  try {
    const buf = await fs.readFile(path.join(photoDir(userId, sessionId, photoId), 'send.jpg'));
    const input = {
      imageBase64: buf.toString('base64'),
      mime: 'image/jpeg',
      model: model || provider.defaultModel,
      // hint：Mock 供应商用 filename 做确定性种子；真实供应商可参考尺寸
      hint: { filename: photo.filename, width: photo.width, height: photo.height },
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
    // 归类成用户可读短句，不透传供应商原始错误
    const message = userFacingError(err).slice(0, 300);
    db.prepare(`UPDATE photos SET status = 'failed', error = ? WHERE id = ?`).run(message, photoId);
  }
}
