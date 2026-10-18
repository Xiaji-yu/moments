export const RATIOS = ['original', '1:1', '3:4', '4:3', '16:9', '9:16'] as const;
export type Ratio = (typeof RATIOS)[number];

/** 归一化裁剪框（0~1） */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ratio 对应的像素宽高比 W/H（'original' 用原图比例） */
export function ratioValue(ratio: Ratio, imgW: number, imgH: number): number {
  switch (ratio) {
    case '1:1':
      return 1;
    case '3:4':
      return 3 / 4;
    case '4:3':
      return 4 / 3;
    case '16:9':
      return 16 / 9;
    case '9:16':
      return 9 / 16;
    case 'original':
    default:
      return imgH > 0 ? imgW / imgH : 1;
  }
}

/**
 * 归一化坐标空间（0~1）下的宽高比。
 * 要让裁剪结果的「像素宽高比」为 R，归一化框需满足 w/h = R * imgH / imgW。
 */
export function normRatio(ratio: Ratio, imgW: number, imgH: number): number {
  const r = ratioValue(ratio, imgW, imgH);
  return imgW > 0 && imgH > 0 ? (r * imgH) / imgW : 1;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 以 (cx, cy) 为中心、比例为 R、内接于单位方形的最大框 */
export function fitRatioBox(cx: number, cy: number, r: number): Box {
  const halfW = Math.min(cx, 1 - cx);
  const halfH = Math.min(cy, 1 - cy);
  let w = 2 * halfW;
  let h = w / r;
  if (h > 2 * halfH) {
    h = 2 * halfH;
    w = h * r;
  }
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * 规整任意来源（AI/用户）的裁剪框（AC-F6-2 服务端硬校验）：
 * - 坐标/尺寸取有限数并 clamp 进画面
 * - 尺寸强制符合所选比例（保持中心）
 * - 面积 < 原图 20% 时降级为「该比例居中最大框」
 * 返回值保证完全在画面内、比例精确匹配、面积达标。
 */
export function normalizeBox(raw: unknown, ratio: Ratio, imgW: number, imgH: number): Box {
  const r = normRatio(ratio, imgW, imgH);
  let box: Box;

  if (
    raw !== null &&
    typeof raw === 'object' &&
    Number.isFinite((raw as Box).x) &&
    Number.isFinite((raw as Box).y) &&
    Number.isFinite((raw as Box).w) &&
    Number.isFinite((raw as Box).h)
  ) {
    const b = raw as Box;
    const cx = clamp(b.x + b.w / 2, 0, 1);
    const cy = clamp(b.y + b.h / 2, 0, 1);
    let w = clamp(b.w, 0.05, 1);
    let h = w / r;
    if (h > 1) {
      h = 1;
      w = h * r;
    }
    const halfW = Math.min(cx, 1 - cx);
    const halfH = Math.min(cy, 1 - cy);
    w = Math.min(w, 2 * halfW, 2 * halfH * r);
    h = w / r;
    box = { x: cx - w / 2, y: cy - h / 2, w, h };
    if (box.w * box.h < 0.2) {
      box = fitRatioBox(0.5, 0.5, r);
    }
  } else {
    // 完全非法 → 降级为「仅比例，框默认居中」（AC-F6-2）
    box = fitRatioBox(0.5, 0.5, r);
  }
  return {
    x: clamp(box.x, 0, 1),
    y: clamp(box.y, 0, 1),
    w: clamp(box.w, 0.01, 1),
    h: clamp(box.h, 0.01, 1),
  };
}

/** 归一化框 → 原图像素裁剪参数（整数且不越界，AC-F6-4） */
export function boxToPixelExtract(box: Box, imgW: number, imgH: number) {
  const left = clamp(Math.round(box.x * imgW), 0, imgW - 1);
  const top = clamp(Math.round(box.y * imgH), 0, imgH - 1);
  const width = clamp(Math.round(box.w * imgW), 1, imgW - left);
  const height = clamp(Math.round(box.h * imgH), 1, imgH - top);
  return { left, top, width, height };
}

/**
 * 把模型输出的框当作「主体位置 + 大致范围」的语义信号，生成几何正确的裁剪框：
 * - 以模型指认的主体位置为中心（优先用显式的 subject 坐标，否则用框中心），
 *   取该比例下内接画面的最大框；
 * - 按模型框面积占最大框的比例等比缩放（不低于 minArea 对应的尺度）；
 * - 没有任何信号 → 该比例居中最大框。
 *
 * 为什么 AI 建议不走 normalizeBox：模型并不知道原图宽高比，输出的框比例几乎不可能
 * 精确匹配所选 ratio；normalizeBox 会"保持中心强行压扁/拉高"，框很容易被推离主体。
 * 这里只信任模型指认的"主体在哪、想裁多大"，几何精度由服务端保证。
 */
export function boxFromModelHint(
  raw: unknown,
  ratio: Ratio,
  imgW: number,
  imgH: number,
  subject?: { x: number; y: number } | null,
  minArea = 0.2,
): Box {
  const r = normRatio(ratio, imgW, imgH);

  // 主体坐标优先：显式指认 > 框中心 > 画面正中
  const hasSubject =
    subject != null && Number.isFinite(subject.x) && Number.isFinite(subject.y);
  const boxValid =
    raw !== null &&
    typeof raw === 'object' &&
    Number.isFinite((raw as Box).x) &&
    Number.isFinite((raw as Box).y) &&
    Number.isFinite((raw as Box).w) &&
    Number.isFinite((raw as Box).h);

  if (!hasSubject && !boxValid) return fitRatioBox(0.5, 0.5, r);

  const b = (boxValid ? raw : { x: 0.5, y: 0.5, w: 1, h: 1 }) as Box;
  const cx = hasSubject ? clamp(subject!.x, 0, 1) : clamp(b.x + b.w / 2, 0, 1);
  const cy = hasSubject ? clamp(subject!.y, 0, 1) : clamp(b.y + b.h / 2, 0, 1);
  const max = fitRatioBox(cx, cy, r);
  const maxArea = Math.max(max.w * max.h, 1e-6);

  // 只取"想裁多大"的面积信号，不受模型框形状与比例误差干扰
  const hintArea = clamp(b.w * b.h, 0.01, 1);
  let scale = Math.sqrt(hintArea / maxArea);
  scale = Math.max(scale, Math.sqrt(minArea / maxArea)); // 面积不低于下限
  scale = Math.min(scale, 1);

  const w = max.w * scale;
  const h = w / r;
  return {
    x: clamp(cx - w / 2, 0, Math.max(0, 1 - w)),
    y: clamp(cy - h / 2, 0, Math.max(0, 1 - h)),
    w,
    h,
  };
}

/**
 * 框与理由一致性校验。
 *
 * 模型的 reasoning 和 box/subject 是同一次生成里的两段独立内容，常见的"漂移"是：
 * 文案声称「裁去顶部水印」「双眼落在三分线」「聚焦特写」，但服务端按 subject 重算后的
 * 框其实是居中、贴满、面积接近原图的。这里不阻断保存，只把矛盾点以可读文本返回，
 * 供接口与 UI 提示（配合 version 字段判断建议是否需要重算）。
 */
export function checkCropConsistency(
  reasoning: string,
  box: Box,
  ratio: Ratio,
  imgW: number,
  imgH: number,
): string[] {
  const warnings: string[] = [];
  const edge = 0.06;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  if (/(水印|日期|顶部|上方)/.test(reasoning) && box.y < edge) {
    warnings.push('理由称裁去顶部（水印/杂物），但框仍保留顶部约 6%');
  }
  if (/(底部|下方|下边缘)/.test(reasoning) && box.y + box.h > 1 - edge) {
    warnings.push('理由称裁去底部，但框仍保留底部约 6%');
  }
  if (/(左侧|左边)/.test(reasoning) && box.x < edge) {
    warnings.push('理由称裁去左侧，但框仍保留左侧约 6%');
  }
  if (/(右侧|右边)/.test(reasoning) && box.x + box.w > 1 - edge) {
    warnings.push('理由称裁去右侧，但框仍保留右侧约 6%');
  }
  if (/(三分(点|线|法|构图)|黄金分割)/.test(reasoning)) {
    const nearThird = (v: number) => Math.abs(v - 1 / 3) <= 0.1 || Math.abs(v - 2 / 3) <= 0.1;
    if (!nearThird(cx) && !nearThird(cy)) {
      warnings.push('理由称三分点/三分线，但框中心不在三分线附近');
    }
  }
  if (/(特写|聚焦|近距离)/.test(reasoning) && box.w * box.h > 0.8) {
    warnings.push('理由称聚焦/特写，但框覆盖原图 80% 以上，接近原图');
  }
  if (ratio !== 'original' && imgW > 0 && imgH > 0) {
    const target = ratioValue(ratio, imgW, imgH);
    const own = imgW / imgH;
    if (Math.abs(target / own - 1) < 0.02) {
      warnings.push('所选比例与原图一致，建议等同于等比切线，没有改变构图');
    }
  }
  return warnings;
}
