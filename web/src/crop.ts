import type { Box, Ratio } from './types';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** ratio 的像素宽高比 W/H（'original' 用原图比例） */
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
 * 归一化坐标空间（0~1）下的宽高比：要让裁剪像素比为 R，归一化 w/h = R * imgH / imgW。
 * 拖拽缩放与比例切换都要用这个值。
 */
export function normRatio(ratio: Ratio, imgW: number, imgH: number): number {
  const r = ratioValue(ratio, imgW, imgH);
  return imgW > 0 && imgH > 0 ? (r * imgH) / imgW : 1;
}

/** 以 (cx, cy) 为中心、比例为 r、内接于单位方形的最大框 */
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

/** 保持中心，把框调整为符合比例 r */
export function fitBoxToRatio(box: Box, r: number): Box {
  const cx = clamp(box.x + box.w / 2, 0, 1);
  const cy = clamp(box.y + box.h / 2, 0, 1);
  const target = fitRatioBox(cx, cy, r);
  // 尽量贴近原尺寸：以原框面积为基准在该比例下重构
  const area = Math.max(box.w * box.h, 0.04);
  let w = Math.sqrt(area * r);
  let h = w / r;
  w = Math.min(w, target.w);
  h = Math.min(h, target.h, w / r);
  w = Math.min(w, h * r);
  w = Math.max(w, 0.05);
  h = w / r;
  return {
    x: clamp(cx - w / 2, 0, 1 - w),
    y: clamp(cy - h / 2, 0, 1 - h),
    w,
    h,
  };
}

/** 归一化框 → 像素显示文本 */
export function boxPixelText(box: Box, imgW: number, imgH: number): string {
  const w = Math.round(box.w * imgW);
  const h = Math.round(box.h * imgH);
  return `${w} × ${h} px`;
}
