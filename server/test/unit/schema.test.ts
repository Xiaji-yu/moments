import { describe, expect, it } from 'vitest';
import { AnalysisSchema, CropSuggestionSchema, ISSUE_VALUES } from '../../src/services/schema.js';

describe('AnalysisSchema（AI 分析输出的 JSON Schema 校验）', () => {
  it('合法输出通过', () => {
    const r = AnalysisSchema.safeParse({
      score: 8,
      tags: ['海边', '日落'],
      issues: ['过曝'],
      reason: '光线好构图佳',
    });
    expect(r.success).toBe(true);
  });

  it('score 必须是 1~10 的整数，字符串数字可被纠正', () => {
    expect(AnalysisSchema.safeParse({ score: 0, reason: 'x' }).success).toBe(false);
    expect(AnalysisSchema.safeParse({ score: 11, reason: 'x' }).success).toBe(false);
    expect(AnalysisSchema.safeParse({ score: 7.5, reason: 'x' }).success).toBe(false);
    const coerced = AnalysisSchema.parse({ score: '8', reason: 42 });
    expect(coerced.score).toBe(8);
    expect(coerced.reason).toBe('42');
  });

  it('tags 最多 8 个且非空字符串', () => {
    expect(AnalysisSchema.safeParse({ score: 5, reason: 'x', tags: Array(9).fill('t') }).success).toBe(false);
    expect(AnalysisSchema.safeParse({ score: 5, reason: 'x', tags: [''] }).success).toBe(false);
  });

  it('issues 只允许枚举值', () => {
    expect(AnalysisSchema.safeParse({ score: 5, reason: 'x', issues: ['手抖'] }).success).toBe(false);
    expect(AnalysisSchema.safeParse({ score: 5, reason: 'x', issues: ['模糊', '闭眼'] }).success).toBe(true);
  });

  it('tags/issues 可省略（默认空数组），reason 必填且 1~200 字', () => {
    const r = AnalysisSchema.parse({ score: 5, reason: '好' });
    expect(r.tags).toEqual([]);
    expect(r.issues).toEqual([]);
    expect(AnalysisSchema.safeParse({ score: 5 }).success).toBe(false);
    expect(AnalysisSchema.safeParse({ score: 5, reason: '' }).success).toBe(false);
    expect(AnalysisSchema.safeParse({ score: 5, reason: 'x'.repeat(201) }).success).toBe(false);
  });

  it('ISSUE_VALUES 覆盖 7 种质量问题', () => {
    expect(ISSUE_VALUES).toEqual(['模糊', '过曝', '欠曝', '闭眼', '构图差', '画面杂乱', '重复帧']);
  });
});

describe('CropSuggestionSchema（裁剪建议输出校验）', () => {
  it('合法建议通过；非法 ratio 归一为 original', () => {
    const ok = CropSuggestionSchema.parse({ ratio: '1:1', box: { x: 0, y: 0, w: 1, h: 1 }, reasoning: '主体居中' });
    expect(ok.ratio).toBe('1:1');
    const bad = CropSuggestionSchema.parse({ ratio: '21:9', box: null, reasoning: '原始' });
    expect(bad.ratio).toBe('original');
  });

  it('box 可空；reasoning 必填且 ≤60 字', () => {
    expect(CropSuggestionSchema.safeParse({ ratio: '1:1', reasoning: 'ok' }).success).toBe(true);
    expect(CropSuggestionSchema.safeParse({ ratio: '1:1' }).success).toBe(false);
    expect(CropSuggestionSchema.safeParse({ ratio: '1:1', reasoning: '' }).success).toBe(false);
    expect(CropSuggestionSchema.safeParse({ ratio: '1:1', reasoning: 'x'.repeat(61) }).success).toBe(false);
  });
});
