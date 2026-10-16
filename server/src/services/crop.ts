import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { httpErr } from '../util.js';
import { getProvider } from './providers/registry.js';
import { CropSuggestionSchema } from './schema.js';
import { normalizeBox, normRatio, RATIOS, type Ratio } from './cropBox.js';
import { photoDir } from './storage.js';
import { config } from '../config.js';
import { recordUsage } from './usage.js';

interface SuggestionRow {
  ratio: string;
  box_x: number;
  box_y: number;
  box_w: number;
  box_h: number;
  reasoning: string;
}

const batchRunning = new Set<string>();
const batchProgress = new Map<string, { total: number; done: number }>();

export function getCropProgress(sessionId: string): { running: boolean; total: number; done: number } {
  const p = batchProgress.get(sessionId);
  return { running: batchRunning.has(sessionId), total: p?.total ?? 0, done: p?.done ?? 0 };
}

export async function suggestCropForPhoto(
  sessionId: string,
  userId: number,
  photoId: string,
  providerId: string,
  model: string,
  retryWithCorrection = false,
): Promise<void> {
  const photo = db
    .prepare('SELECT * FROM photos WHERE id = ? AND session_id = ?')
    .get(photoId, sessionId) as
    | { id: string; filename: string; width: number; height: number; status: string }
    | undefined;
  if (!photo) throw httpErr(404, '照片不存在');
  if (photo.status !== 'done') throw httpErr(409, '请先完成 AI 分析再生成构图建议');

  const provider = getProvider(providerId);
  const buf = await fs.readFile(path.join(photoDir(userId, sessionId, photoId), 'send.jpg'));
  const input = {
    imageBase64: buf.toString('base64'),
    mime: 'image/jpeg',
    model: model || provider.defaultModel,
    width: photo.width,
    height: photo.height,
    hint: { filename: photo.filename },
  };

  let res = await provider.suggestCrop({ ...input });
  let parsed = CropSuggestionSchema.safeParse(res.data);
  if (!parsed.success && !retryWithCorrection) {
    res = await provider.suggestCrop({
      ...input,
      corrective: '你上一次的输出不是合法 JSON 或字段取值不符合要求，请严格只输出符合约定的 JSON 对象。',
    });
    parsed = CropSuggestionSchema.safeParse(res.data);
  }
  const raw = parsed.success
    ? parsed.data
    : { ratio: 'original' as Ratio, box: null, reasoning: '构图建议生成失败，请重试' }; // 降级

  // AC-F6-2：服务端硬校验 + 降级（框进画面、比例精确、面积 ≥ 20%）
  const ratio = RATIOS.includes(raw.ratio as Ratio) ? (raw.ratio as Ratio) : 'original';
  const box = normalizeBox(raw.box, ratio, photo.width, photo.height);

  const reasoning = raw.reasoning.slice(0, 60);

  db.prepare(
    `INSERT INTO crop_suggestions (photo_id, ratio, box_x, box_y, box_w, box_h, reasoning, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(photo_id) DO UPDATE SET
       ratio = excluded.ratio, box_x = excluded.box_x, box_y = excluded.box_y,
       box_w = excluded.box_w, box_h = excluded.box_h, reasoning = excluded.reasoning, model = excluded.model`,
  ).run(photoId, ratio, box.x, box.y, box.w, box.h, reasoning, input.model);
  recordUsage(sessionId, photoId, 'crop', input.model, res.usage);
}

/** 批量为会话内照片生成构图建议（异步执行，进度用 getCropProgress 轮询） */
export function startBatchCropSuggest(
  sessionId: string,
  userId: number,
  providerId: string,
  model: string,
  force: boolean,
): void {
  if (batchRunning.has(sessionId)) throw httpErr(409, '已有构图建议任务进行中');
  let photos = db
    .prepare(`SELECT id FROM photos WHERE session_id = ? AND status = 'done' ORDER BY taken_at, created_at`)
    .all(sessionId) as Array<{ id: string }>;
  if (!force) {
    const having = new Set(
      (db.prepare('SELECT photo_id FROM crop_suggestions').all() as Array<{ photo_id: string }>).map(
        (r) => r.photo_id,
      ),
    );
    photos = photos.filter((p) => !having.has(p.id));
  }
  if (photos.length === 0) return;

  batchRunning.add(sessionId);
  batchProgress.set(sessionId, { total: photos.length, done: 0 });
  void (async () => {
    try {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < photos.length) {
          const p = photos[cursor++];
          try {
            await suggestCropForPhoto(sessionId, userId, p.id, providerId, model);
          } catch {
            // 单张失败不阻塞批次
          }
          const progress = batchProgress.get(sessionId);
          if (progress) progress.done++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(config.modelConcurrency, photos.length) }, worker));
    } finally {
      batchRunning.delete(sessionId);
    }
  })();
}

/** 保存用户应用的裁剪（AC-F6-3/6）；source='original' 表示还原不裁剪 */
export function saveCrop(
  photoId: string,
  sessionId: string,
  userId: number,
  body: { ratio?: string; box?: { x: number; y: number; w: number; h: number }; source?: string },
): void {
  const photo = db
    .prepare('SELECT * FROM photos WHERE id = ? AND session_id = ? AND user_id = ?')
    .get(photoId, sessionId, userId) as { id: string; width: number; height: number } | undefined;
  if (!photo) throw httpErr(404, '照片不存在');

  const source = body.source === 'ai' || body.source === 'manual' ? body.source : 'manual';
  const ratio = RATIOS.includes(body.ratio as Ratio) ? (body.ratio as Ratio) : 'original';

  // 还原原始：清除裁剪记录（AC-F6-3「还原」）
  if (body.source === 'original' || !body.box) {
    db.prepare('DELETE FROM crops WHERE photo_id = ?').run(photoId);
    return;
  }

  const box = normalizeBox(body.box, ratio, photo.width, photo.height);
  db.prepare(
    `INSERT INTO crops (photo_id, ratio, box_x, box_y, box_w, box_h, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(photo_id) DO UPDATE SET
       ratio = excluded.ratio, box_x = excluded.box_x, box_y = excluded.box_y,
       box_w = excluded.box_w, box_h = excluded.box_h, source = excluded.source, created_at = datetime('now')`,
  ).run(photoId, ratio, box.x, box.y, box.w, box.h, source);
}

export function readSuggestion(photoId: string): SuggestionRow | undefined {
  return db.prepare('SELECT * FROM crop_suggestions WHERE photo_id = ?').get(photoId) as
    | SuggestionRow
    | undefined;
}
