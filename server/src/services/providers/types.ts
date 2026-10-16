export interface AnalyzeInput {
  /** 压缩图 base64（不带 data: 前缀） */
  imageBase64: string;
  mime: string;
  model: string;
  /** 输出非法时的纠错指令（AC-F3-4 重试） */
  corrective?: string;
  hint?: { filename: string; width: number; height: number };
}

export interface SuggestCropInput {
  imageBase64: string;
  mime: string;
  model: string;
  width: number;
  height: number;
  /** 输出非法时的纠错指令 */
  corrective?: string;
  hint?: { filename: string };
}

export interface VisionProvider {
  id: string;
  label: string;
  models: string[];
  defaultModel: string;
  /** 返回未校验的原始 JSON 对象，schema 校验统一在管线里做 */
  analyzePhoto(input: AnalyzeInput): Promise<unknown>;
  /** 二次构图建议：返回未校验 JSON（ratio/box/reasoning），校验与降级在 crop 服务做 */
  suggestCrop(input: SuggestCropInput): Promise<unknown>;
}
