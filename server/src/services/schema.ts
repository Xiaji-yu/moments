import { z } from 'zod';

export const ISSUE_VALUES = ['模糊', '过曝', '欠曝', '闭眼', '构图差', '画面杂乱', '重复帧'] as const;

export const AnalysisSchema = z.object({
  score: z.coerce.number().int().min(1).max(10),
  tags: z.array(z.coerce.string().min(1)).max(8).default([]),
  issues: z.array(z.enum(ISSUE_VALUES)).max(ISSUE_VALUES.length).default([]),
  reason: z.coerce.string().min(1).max(200),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
