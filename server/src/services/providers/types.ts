export interface TokenUsage {
  input?: number;
  output?: number;
}

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

export type CaptionStyle = '混合' | '简洁' | '文艺' | '搞笑';

export interface CaptionInput {
  model: string;
  tags: string[];
  reasons: string[];
  style: CaptionStyle;
  note?: string;
  corrective?: string;
}

export interface ProviderResult<T> {
  data: T;
  usage?: TokenUsage;
}

export interface VisionProvider {
  id: string;
  label: string;
  models: string[];
  defaultModel: string;
  /** 返回未校验的原始 JSON，schema 校验统一在管线里做 */
  analyzePhoto(input: AnalyzeInput): Promise<ProviderResult<unknown>>;
  /** 二次构图建议：返回未校验 JSON（ratio/box/reasoning），校验与降级在 crop 服务做 */
  suggestCrop(input: SuggestCropInput): Promise<ProviderResult<unknown>>;
  /** 朋友圈文案：仅文本调用，不传图（AC-F7-1） */
  generateCaptions(input: CaptionInput): Promise<ProviderResult<string[]>>;
}
