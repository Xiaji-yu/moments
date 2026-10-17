import { z } from 'zod';
import { RATIOS, type Ratio } from './cropBox.js';

export const ISSUE_VALUES = ['模糊', '过曝', '欠曝', '闭眼', '构图差', '画面杂乱', '重复帧'] as const;

export const AnalysisSchema = z.object({
  score: z.coerce.number().int().min(1).max(10),
  tags: z.array(z.coerce.string().min(1)).max(8).default([]),
  issues: z.array(z.enum(ISSUE_VALUES)).max(ISSUE_VALUES.length).default([]),
  reason: z.coerce.string().min(1).max(200),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

export const CropSuggestionSchema = z.object({
  ratio: z.coerce.string().transform((v) => (RATIOS.includes(v as Ratio) ? (v as Ratio) : 'original')),
  box: z
    .object({ x: z.coerce.number(), y: z.coerce.number(), w: z.coerce.number(), h: z.coerce.number() })
    .nullable()
    .default(null),
  /** 最主要主体的归一化中心坐标；模型必须给出，服务端优先以它定位裁剪框 */
  subject: z
    .object({ x: z.coerce.number(), y: z.coerce.number() })
    .nullable()
    .catch(null)
    .default(null),
  reasoning: z.coerce.string().min(1).max(60),
});

export type CropSuggestionRaw = z.infer<typeof CropSuggestionSchema>;
