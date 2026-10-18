import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { httpErr } from '../util.js';
import { getProvider } from './providers/registry.js';
import { CropSuggestionSchema } from './schema.js';
import { normalizeBox, boxFromModelHint, normRatio, checkCropConsistency, RATIOS, type Ratio } from './cropBox.js';
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
  model: string | null;
  version: number;
  warnings: string;
}

/**
 * 建议的算法版本。改了 prompt / 几何策略 / 一致性规则就 +1：
 * 生成批次会把 version 不同的旧建议视为过期并重算（crop_suggestions.version）。
 */
export const CROP_SUGGEST_VERSION = 2;

export interface CropProgress {
  running: boolean;
  total: number;
  done: number;
  cancelled: boolean;
}

/**
 * 批量任务进度持久化在 crop_jobs 表（而非内存 Map）：
 * 进程重启后前端轮询仍能拿到 done/total，从而区分「完成」与「被中断」。
 */
export function getCropProgress(sessionId: string): CropProgress {
  const row = db
    .prepare('SELECT total, done, cancelled, running FROM crop_jobs WHERE session_id = ?')
    .get(sessionId) as
    | { total: number; done: number; cancelled: number; running: number }
    | undefined;
  return {
    running: !!row?.running,
    total: row?.total ?? 0,
    done: row?.done ?? 0,
    cancelled: !!row?.cancelled,
  };
}

export function requestCancelBatchCrop(sessionId: string): void {
  db.prepare(`UPDATE crop_jobs SET cancelled = 1, updated_at = datetime('now') WHERE session_id = ?`).run(
    sessionId,
  );
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
  const firstParseOk = CropSuggestionSchema.safeParse(res.data).success;
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
    : { ratio: 'original' as Ratio, box: null, subject: null, reasoning: '构图建议生成失败，请重试' }; // 降级

  // AC-F6-2：AI 建议只信任「主体位置 + 大致范围」，几何精度由服务端保证。
  // subject 坐标优先于框中心（模型显式指认的主体比它顺手画的框更可靠）；
  // 面积下限取 30%：20% 会允许裁出细条，不符合"发朋友圈"的实际需要。
  const ratio = RATIOS.includes(raw.ratio as Ratio) ? (raw.ratio as Ratio) : 'original';
  const box = boxFromModelHint(raw.box, ratio, photo.width, photo.height, raw.subject, 0.3);
  const warnings = checkCropConsistency(raw.reasoning, box, ratio, photo.width, photo.height);

  const reasoning = raw.reasoning.slice(0, 60);

  // 诊断日志：完整链路一次打全，用于判断「建议不对」的根因——
  //   subject 缺失/落在画面正中 → 模型语义问题（它没找到主体）
  //   subject 在主体处但 finalBox 偏了 → 服务端几何问题
  //   ratio 不合理 → 模型比例选择问题
  // dev 时在 `npm run dev` 的 api 输出里；Docker 用 `docker compose logs -f app | grep crop-suggest`
  const hasSubject =
    raw.subject != null && Number.isFinite(raw.subject.x) && Number.isFinite(raw.subject.y);
  console.info(
    '[crop-suggest] ' +
      JSON.stringify({
        photoId,
        provider: providerId,
        model: input.model,
        imageSize: { w: photo.width, h: photo.height },
        firstParseOk,
        retriedWithCorrection: !firstParseOk && parsed.success,
        rawData: res.data,
        parsed: parsed.success
          ? { ratio: parsed.data.ratio, subject: parsed.data.subject, box: parsed.data.box }
          : null,
        boxSource: hasSubject ? 'subject' : raw.box ? 'box-center' : 'fallback-center',
        finalBox: {
          norm: { x: +box.x.toFixed(4), y: +box.y.toFixed(4), w: +box.w.toFixed(4), h: +box.h.toFixed(4) },
          area: +(box.w * box.h).toFixed(4),
        },
        warnings,
        usage: res.usage,
      }),
  );

  db.prepare(
    `INSERT INTO crop_suggestions (photo_id, ratio, box_x, box_y, box_w, box_h, reasoning, model, version, warnings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(photo_id) DO UPDATE SET
       ratio = excluded.ratio, box_x = excluded.box_x, box_y = excluded.box_y,
       box_w = excluded.box_w, box_h = excluded.box_h, reasoning = excluded.reasoning,
       model = excluded.model, version = excluded.version, warnings = excluded.warnings,
       created_at = datetime('now')`,
  ).run(
    photoId,
    ratio,
    box.x,
    box.y,
    box.w,
    box.h,
    reasoning,
    input.model,
    CROP_SUGGEST_VERSION,
    JSON.stringify(warnings),
  );
  recordUsage(sessionId, photoId, 'crop', input.model, res.usage);
}

/** 批量为会话内照片生成构图建议（异步执行，进度用 getCropProgress 轮询）。
 *  photoIds：限定只给这些照片生成（如 AI 挑图选中的若干张）；缺省为全部已完成分析的照片。 */
export function startBatchCropSuggest(
  sessionId: string,
  userId: number,
  providerId: string,
  model: string,
  force: boolean,
  photoIds?: string[],
): void {
  if (getCropProgress(sessionId).running) throw httpErr(409, '已有构图建议任务进行中');

  let photos = db
    .prepare(`SELECT id FROM photos WHERE session_id = ? AND status = 'done' ORDER BY taken_at, created_at`)
    .all(sessionId) as Array<{ id: string }>;
  if (photoIds && photoIds.length > 0) {
    const ids = new Set(photoIds);
    photos = photos.filter((p) => ids.has(p.id));
  }
  if (!force) {
    // 跳过「当前版本 + 同一模型」已生成过的建议；旧版本（含 mock 时代）或换模型后的
    // 建议一律视为过期并重算，避免 UI 里同屏混着不同来源的框。
    const effectiveModel = model || getProvider(providerId).defaultModel;
    const upToDate = new Set(
      (
        db
          .prepare(
            `SELECT cs.photo_id FROM crop_suggestions cs JOIN photos p ON p.id = cs.photo_id
             WHERE p.session_id = ? AND cs.version = ? AND cs.model = ?`,
          )
          .all(sessionId, CROP_SUGGEST_VERSION, effectiveModel) as Array<{ photo_id: string }>
      ).map((r) => r.photo_id),
    );
    photos = photos.filter((p) => !upToDate.has(p.id));
  }

  // 没有可生成的：复位任务记录，避免前端沿用上次的 done/total 误报「完成 N 张」
  if (photos.length === 0) {
    db.prepare(
      `INSERT INTO crop_jobs (session_id, total, done, cancelled, running) VALUES (?, 0, 0, 0, 0)
       ON CONFLICT(session_id) DO UPDATE SET
         total = 0, done = 0, cancelled = 0, running = 0, updated_at = datetime('now')`,
    ).run(sessionId);
    return;
  }

  db.prepare(
    `INSERT INTO crop_jobs (session_id, total, done, cancelled, running) VALUES (?, ?, 0, 0, 1)
     ON CONFLICT(session_id) DO UPDATE SET
       total = excluded.total, done = 0, cancelled = 0, running = 1, updated_at = datetime('now')`,
  ).run(sessionId, photos.length);

  void (async () => {
    try {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < photos.length) {
          const p = photos[cursor++];
          if (getCropProgress(sessionId).cancelled) return;
          try {
            await suggestCropForPhoto(sessionId, userId, p.id, providerId, model);
          } catch {
            // 单张失败不阻塞批次
          }
          db.prepare(
            `UPDATE crop_jobs SET done = done + 1, updated_at = datetime('now') WHERE session_id = ?`,
          ).run(sessionId);
        }
      };
      await Promise.all(Array.from({ length: Math.min(config.modelConcurrency, photos.length) }, worker));
    } finally {
      db.prepare(
        `UPDATE crop_jobs SET running = 0, updated_at = datetime('now') WHERE session_id = ?`,
      ).run(sessionId);
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
