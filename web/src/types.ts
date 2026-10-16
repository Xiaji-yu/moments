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
}

export type PhotoStatus = 'ready' | 'analyzing' | 'done' | 'failed';

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
}

export interface SessionInfo {
  id: string;
  provider: string;
  model: string | null;
}

export interface SessionDetail {
  session: SessionInfo;
  photos: Photo[];
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
