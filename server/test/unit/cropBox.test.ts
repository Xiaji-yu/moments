import { describe, expect, it } from 'vitest';
import {
  RATIOS,
  boxFromModelHint,
  boxToPixelExtract,
  fitRatioBox,
  normRatio,
  normalizeBox,
  ratioValue,
  type Box,
} from '../../src/services/cropBox.js';

const inFrame = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9;

describe('ratioValue', () => {
  it('各固定比例对应正确的 W/H', () => {
    expect(ratioValue('1:1', 0, 0)).toBe(1);
    expect(ratioValue('3:4', 0, 0)).toBeCloseTo(0.75);
    expect(ratioValue('4:3', 0, 0)).toBeCloseTo(4 / 3);
    expect(ratioValue('16:9', 0, 0)).toBeCloseTo(16 / 9);
    expect(ratioValue('9:16', 0, 0)).toBeCloseTo(9 / 16);
  });

  it("original 用原图比例，异常尺寸回退 1", () => {
    expect(ratioValue('original', 1920, 1080)).toBeCloseTo(16 / 9);
    expect(ratioValue('original', 1080, 1920)).toBeCloseTo(9 / 16);
    expect(ratioValue('original', 0, 0)).toBe(1);
  });
});

describe('normRatio（归一化空间宽高比）', () => {
  it('横图上 4:3 的归一化框是正方形（w/h=1）', () => {
    // (4/3) * (3000/4000) = 1
    expect(normRatio('4:3', 4000, 3000)).toBeCloseTo(1);
  });

  it('竖图上 4:3 的归一化框 w/h = 16/9', () => {
    expect(normRatio('4:3', 3000, 4000)).toBeCloseTo(16 / 9);
  });

  it('异常尺寸回退 1', () => {
    expect(normRatio('1:1', 0, 500)).toBe(1);
  });
});

describe('fitRatioBox（内接最大框）', () => {
  it('单位方形中心 + 1:1 → 全画面', () => {
    expect(fitRatioBox(0.5, 0.5, 1)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('中心 + 4:3 → 上下留边', () => {
    const b = fitRatioBox(0.5, 0.5, 4 / 3);
    expect(b.w).toBeCloseTo(1);
    expect(b.h).toBeCloseTo(0.75);
    expect(b.x).toBeCloseTo(0);
    expect(b.y).toBeCloseTo(0.125);
  });

  it('中心贴近边缘时内接于画面', () => {
    const b = fitRatioBox(0.1, 0.5, 1);
    expect(b.w).toBeCloseTo(0.2);
    expect(b.h).toBeCloseTo(0.2);
    expect(inFrame(b)).toBe(true);
  });
});

describe('normalizeBox（AC-F6-2 服务端硬校验）', () => {
  it('合法框：强制到指定比例并保持中心，保持在画面内', () => {
    // 1000x500 图、1:1 → 归一化 w/h 必须 0.5
    const b = normalizeBox({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, '1:1', 1000, 500);
    expect(inFrame(b)).toBe(true);
    expect(b.w / b.h).toBeCloseTo(0.5); // 归一化比例精确
    // 像素比恰好 1:1
    const px = boxToPixelExtract(b, 1000, 500);
    expect(px.width / px.height).toBeCloseTo(1, 1);
    expect(b.w * b.h).toBeGreaterThanOrEqual(0.2); // 面积达标
  });

  it('面积 < 20% 降级为该比例居中最大框', () => {
    const b = normalizeBox({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 }, '1:1', 1000, 1000);
    expect(b).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('中心在画面外（越界框）也安全降级', () => {
    const b = normalizeBox({ x: -0.5, y: -0.5, w: 1, h: 1 }, '1:1', 1000, 1000);
    expect(inFrame(b)).toBe(true);
    expect(b.w * b.h).toBeGreaterThanOrEqual(0.2);
  });

  it.each([null, undefined, 'bad', { x: NaN, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: Infinity, w: 0.5, h: 0.5 }])(
    '完全非法输入 %j 降级为居中最大框',
    (raw) => {
      const b = normalizeBox(raw, '3:4', 2000, 1000);
      const expected = fitRatioBox(0.5, 0.5, normRatio('3:4', 2000, 1000));
      expect(b.x).toBeCloseTo(expected.x);
      expect(b.y).toBeCloseTo(expected.y);
      expect(b.w).toBeCloseTo(expected.w);
      expect(b.h).toBeCloseTo(expected.h);
    },
  );

  it('输出恒在 0~1 内（最后一道 clamp）', () => {
    const b = normalizeBox({ x: -10, y: -10, w: 50, h: 50 }, '16:9', 800, 600);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.w).toBeLessThanOrEqual(1);
    expect(b.h).toBeLessThanOrEqual(1);
  });
});

describe('boxToPixelExtract（归一化 → 原图像素，AC-F6-4）', () => {
  it('常规换算为整数像素', () => {
    expect(boxToPixelExtract({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, 1000, 800)).toEqual({
      left: 100,
      top: 160,
      width: 500,
      height: 480,
    });
  });

  it('全画面框 → 全图', () => {
    expect(boxToPixelExtract({ x: 0, y: 0, w: 1, h: 1 }, 640, 480)).toEqual({
      left: 0,
      top: 0,
      width: 640,
      height: 480,
    });
  });

  it('框越出画面时收缩不越界', () => {
    const px = boxToPixelExtract({ x: 0.99, y: 0.99, w: 0.1, h: 0.1 }, 100, 100);
    expect(px.left).toBeLessThanOrEqual(99);
    expect(px.top).toBeLessThanOrEqual(99);
    expect(px.left + px.width).toBeLessThanOrEqual(100);
    expect(px.top + px.height).toBeLessThanOrEqual(100);
    expect(px.width).toBeGreaterThanOrEqual(1);
    expect(px.height).toBeGreaterThanOrEqual(1);
  });
});

describe('RATIOS 常量', () => {
  it('包含全部 6 个候选比例', () => {
    expect(RATIOS).toEqual(['original', '1:1', '3:4', '4:3', '16:9', '9:16']);
  });
});

describe('boxFromModelHint（AI 建议：只信任主体位置与大致范围）', () => {
  const IMG_W = 1600;
  const IMG_H = 1000;

  it('框的中心跟随模型指认的主体位置（即使模型框比例不符）', () => {
    // 模型给了个很宽很扁的框，中心在左上主体处 (0.25, 0.3)，但说 ratio=1:1
    const box = boxFromModelHint({ x: 0.05, y: 0.2, w: 0.4, h: 0.2 }, '1:1', IMG_W, IMG_H);
    expect(box.x + box.w / 2).toBeCloseTo(0.25, 2);
    expect(box.y + box.h / 2).toBeCloseTo(0.3, 2);
  });

  it('输出框换算成像素后宽高比与所选 ratio 一致', () => {
    for (const ratio of ['1:1', '3:4', '4:3', '16:9', '9:16', 'original'] as const) {
      const box = boxFromModelHint({ x: 0.1, y: 0.15, w: 0.5, h: 0.5 }, ratio, IMG_W, IMG_H);
      const pxW = box.w * IMG_W;
      const pxH = box.h * IMG_H;
      const expected = ratioValue(ratio, IMG_W, IMG_H);
      expect(Math.abs(pxW / pxH - expected)).toBeLessThan(0.02);
    }
  });

  it('完全落在画面内', () => {
    const box = boxFromModelHint({ x: 0.8, y: 0.85, w: 0.3, h: 0.3 }, '1:1', IMG_W, IMG_H);
    expect(inFrame(box)).toBe(true);
  });

  it('模型想裁得小 → 输出框也小（但不低于原图 20% 面积）', () => {
    const small = boxFromModelHint({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 'original', IMG_W, IMG_H);
    expect(small.w * small.h).toBeGreaterThanOrEqual(0.2 - 1e-6);
    const big = boxFromModelHint({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 'original', IMG_W, IMG_H);
    expect(big.w * big.h).toBeGreaterThan(small.w * small.h);
  });

  it('模型没给框 / 框非法 → 该比例居中最大框（降级）', () => {
    const centered = fitRatioBox(0.5, 0.5, normRatio('1:1', IMG_W, IMG_H));
    expect(boxFromModelHint(null, '1:1', IMG_W, IMG_H)).toEqual(centered);
    expect(boxFromModelHint({ x: 'a', y: 0, w: 1, h: 1 }, '1:1', IMG_W, IMG_H)).toEqual(centered);
    expect(boxFromModelHint(undefined, '1:1', IMG_W, IMG_H)).toEqual(centered);
  });
});
