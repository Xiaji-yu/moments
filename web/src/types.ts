export interface ProviderInfo {
  id: string;
  label: string;
  models: string[];
  defaultModel: string;
}

export interface Analysis {
  score: number;
  tags: string[];
  issues: string[];
  reason: string;
  /** 用户对挑图结果的反馈：1 赞 / -1 踩 / 0 无 */
  feedback?: number;
}

export type PhotoStatus = 'ready' | 'analyzing' | 'done' | 'failed';

export type Ratio = 'original' | '1:1' | '3:4' | '4:3' | '16:9' | '9:16';
export const RATIO_LIST: Ratio[] = ['original', '1:1', '3:4', '4:3', '16:9', '9:16'];
export const RATIO_LABEL: Record<Ratio, string> = {
  original: '原始',
  '1:1': '1:1',
  '3:4': '3:4',
  '4:3': '4:3',
  '16:9': '16:9',
  '9:16': '9:16',
};

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropSuggestion {
  ratio: Ratio;
  box: Box;
  reasoning: string;
}

export interface Crop {
  ratio: Ratio;
  box: Box;
  source: 'ai' | 'manual' | 'original';
}

export interface Photo {
  id: string;
  filename: string;
  status: PhotoStatus;
  error: string | null;
  width: number;
  height: number;
  takenAt: string | null;
  hasExif: boolean;
  analysis: Analysis | null;
  cropSuggestion: CropSuggestion | null;
  crop: Crop | null;
}

export interface SessionInfo {
  id: string;
  title?: string | null;
  provider: string;
  model: string | null;
  photoCount?: number;
  created_at?: string;
}

export interface SessionDetail {
  session: SessionInfo;
  photos: Photo[];
}

export interface CropProgress {
  running: boolean;
  total: number;
  done: number;
  cancelled: boolean;
}

export interface Progress {
  total: number;
  ready: number;
  analyzing: number;
  done: number;
  failed: number;
  running: boolean;
}

export interface SelectedItem {
  order: number;
  photoId: string;
  filename: string;
  score: number;
  reason: string;
  tags: string[];
  issues: string[];
}

export interface RejectedItem {
  photoId: string;
  filename: string;
  score: number;
  category: '重复' | '质量问题' | '内容平淡';
  detail: string;
}

export interface SelectResult {
  selected: SelectedItem[];
  rejected: RejectedItem[];
}

export type CaptionStyle = '混合' | '简洁' | '文艺' | '搞笑';

export interface CaptionItem {
  style: string;
  text: string;
}

export interface UsageSummary {
  calls: number;
  input: number;
  output: number;
  costEstimate: number | null;
}
