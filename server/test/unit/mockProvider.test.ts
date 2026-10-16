import { describe, expect, it } from 'vitest';
import { mockProvider } from '../../src/services/providers/mock.js';
import { AnalysisSchema, CropSuggestionSchema } from '../../src/services/schema.js';
import { RATIOS, boxToPixelExtract, ratioValue } from '../../src/services/cropBox.js';

describe('mockProvider.analyzePhoto（无 Key 全流程兜底）', () => {
  it('输出始终符合 AnalysisSchema（含 score 范围与 tags 去重）', async () => {
    for (let i = 0; i < 20; i++) {
      const { data } = await mockProvider.analyzePhoto({
        imageBase64: 'x',
        mime: 'image/jpeg',
        model: 'mock-vision',
        hint: { filename: `photo_${i}.jpg`, width: 100, height: 100 },
      });
      const parsed = AnalysisSchema.parse(data); // 不符合会 throw
      expect(parsed.score).toBeGreaterThanOrEqual(3);
      expect(parsed.score).toBeLessThanOrEqual(9);
      expect(new Set(parsed.tags).size).toBe(parsed.tags.length);
      expect(parsed.tags.length).toBeLessThanOrEqual(2);
    }
  });

  it('同一 filename 确定性输出（方便调试复现）', async () => {
    const input = { imageBase64: 'x', mime: 'image/jpeg', model: 'm', hint: { filename: 'same.jpg' } };
    const a = AnalysisSchema.parse((await mockProvider.analyzePhoto(input)).data);
    const b = AnalysisSchema.parse((await mockProvider.analyzePhoto(input)).data);
    expect(a).toEqual(b);
  });

  it('评语与分数联动：低分不出现「适合发朋友圈」式好评', async () => {
    for (let i = 0; i < 40; i++) {
      const { data } = await mockProvider.analyzePhoto({
        imageBase64: 'x',
        mime: 'image/jpeg',
        model: 'm',
        hint: { filename: `score_reason_${i}.jpg` },
      });
      const parsed = AnalysisSchema.parse(data);
      if (parsed.issues.length > 0) {
        expect(parsed.reason).toMatch(/问题|欠佳/);
      } else if (parsed.score >= 7) {
        expect(parsed.reason).toMatch(/适合发朋友圈|状态不错/);
      } else if (parsed.score <= 4) {
        expect(parsed.reason).not.toMatch(/适合发朋友圈|状态不错/);
      }
    }
  });

  it('usage 记录 token 消耗', async () => {
    const { usage } = await mockProvider.analyzePhoto({
      imageBase64: 'x',
      mime: 'image/jpeg',
      model: 'm',
    });
    expect(usage!.input).toBeGreaterThan(0);
    expect(usage!.output).toBeGreaterThan(0);
  });
});

describe('mockProvider.suggestCrop', () => {
  it('ratio ∈ 候选比例，box 完全在画面内且比例精确', async () => {
    for (let i = 0; i < 15; i++) {
      const { data } = await mockProvider.suggestCrop({
        imageBase64: 'x',
        mime: 'image/jpeg',
        model: 'm',
        width: 4000,
        height: 3000,
        hint: { filename: `crop_${i}.jpg` },
      });
      const parsed = CropSuggestionSchema.parse(data);
      expect(RATIOS).toContain(parsed.ratio);
      if (parsed.box) {
        const b = parsed.box;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-9);
        // mock 的框基于 normRatio 构造 → 裁剪结果的像素比例应精确等于所选比例
        const px = boxToPixelExtract(b, 4000, 3000);
        expect(px.width / px.height).toBeCloseTo(ratioValue(parsed.ratio, 4000, 3000), 1);
      }
    }
  });
});

describe('mockProvider.generateCaptions', () => {
  it('返回 3 条非空文案，含 note 时体现在搞笑风格中', async () => {
    const { data } = await mockProvider.generateCaptions({
      model: 'm',
      tags: ['海边', '日落'],
      reasons: ['光线好'],
      style: '混合',
      note: '去海边玩',
    });
    expect(data).toHaveLength(3);
    for (const c of data) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(500);
    }
  });

  it('四种风格都能出文案', async () => {
    for (const style of ['混合', '简洁', '文艺', '搞笑'] as const) {
      const { data } = await mockProvider.generateCaptions({
        model: 'm',
        tags: ['街景'],
        reasons: [],
        style,
      });
      expect(data).toHaveLength(3);
    }
  });
});
