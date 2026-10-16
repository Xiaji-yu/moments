import { describe, expect, it } from 'vitest';
import { boxPixelText, fitBoxToRatio, fitRatioBox, normRatio, ratioValue } from '../src/crop';
import type { Box } from '../src/types';

const inFrame = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9;

describe('ratioValue', () => {
  it('固定比例与 original', () => {
    expect(ratioValue('1:1', 0, 0)).toBe(1);
    expect(ratioValue('4:3', 0, 0)).toBeCloseTo(4 / 3);
    expect(ratioValue('original', 1920, 1080)).toBeCloseTo(16 / 9);
    expect(ratioValue('original', 0, 0)).toBe(1);
  });
});

describe('normRatio', () => {
  it('横图 4:3 → 归一化框为正方形', () => {
    expect(normRatio('4:3', 4000, 3000)).toBeCloseTo(1);
  });

  it('异常尺寸回退 1', () => {
    expect(normRatio('1:1', 0, 0)).toBe(1);
  });
});

describe('fitRatioBox', () => {
  it('中心 1:1 → 全画面', () => {
    expect(fitRatioBox(0.5, 0.5, 1)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('贴边中心内接于画面', () => {
    const b = fitRatioBox(0.1, 0.5, 1);
    expect(inFrame(b)).toBe(true);
    expect(b.w).toBeCloseTo(0.2);
  });
});

describe('fitBoxToRatio（保持中心贴近原尺寸重构）', () => {
  it('已符合比例的框保持不变', () => {
    const box: Box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(fitBoxToRatio(box, 1)).toEqual(box);
  });

  it('比例不符的框被重构为该比例且保持中心', () => {
    const box: Box = { x: 0, y: 0, w: 1, h: 0.5 };
    const r = fitBoxToRatio(box, 1);
    expect(r.w / r.h).toBeCloseTo(1);
    expect(r.x + r.w / 2).toBeCloseTo(0.5);
    expect(r.y + r.h / 2).toBeCloseTo(0.25);
    expect(inFrame(r)).toBe(true);
  });

  it('中心贴近边缘时结果仍在画面内', () => {
    const box: Box = { x: 0, y: 0.4, w: 0.2, h: 0.2 };
    const r = fitBoxToRatio(box, 1);
    expect(inFrame(r)).toBe(true);
    expect(r.x + r.w / 2).toBeCloseTo(0.1);
  });

  it('极小框有最小尺寸保护（0.05）', () => {
    const box: Box = { x: 0.5, y: 0.5, w: 0.01, h: 0.01 };
    const r = fitBoxToRatio(box, 1);
    expect(r.w).toBeGreaterThanOrEqual(0.05);
    expect(r.h).toBeGreaterThanOrEqual(0.05);
  });
});

describe('boxPixelText', () => {
  it('归一化框换算为像素展示文本', () => {
    expect(boxPixelText({ x: 0, y: 0, w: 0.5, h: 0.25 }, 1000, 800)).toBe('500 × 200 px');
  });
});
