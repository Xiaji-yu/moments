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
