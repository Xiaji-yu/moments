import { httpErr } from '../../util.js';
import type { VisionProvider } from './types.js';
import { mockProvider } from './mock.js';
import { makeOpenAIProvider } from './openai.js';

export interface ProviderCfg {
  id: string;
  kind: 'mock' | 'openai';
  label: string;
  baseUrl?: string;
  apiKey?: string;
  models: string[];
  defaultModel: string;
}

const splitModels = (raw: string | undefined, fallback: string): string[] =>
  (raw ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);

/** 由环境变量构建可用 Provider 列表；Key 永不外传（AC-F0-1 / NFR-3） */
export function listProviders(): ProviderCfg[] {
  const e = process.env;
  const list: ProviderCfg[] = [
    { id: 'mock', kind: 'mock', label: 'Mock 调试', models: ['mock-vision'], defaultModel: 'mock-vision' },
  ];
  if (e.ZHIPU_API_KEY) {
    list.push({
      id: 'zhipu',
      kind: 'openai',
      label: '智谱 GLM',
      baseUrl: e.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: e.ZHIPU_API_KEY,
      models: splitModels(e.ZHIPU_MODELS, 'glm-4.5v,glm-4v-plus'),
      defaultModel: splitModels(e.ZHIPU_MODELS, 'glm-4.5v')[0],
    });
  }
  if (e.OPENAI_API_KEY) {
    list.push({
      id: 'openai',
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: e.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: e.OPENAI_API_KEY,
      models: splitModels(e.OPENAI_MODELS, 'gpt-4o-mini,gpt-4o'),
      defaultModel: splitModels(e.OPENAI_MODELS, 'gpt-4o-mini')[0],
    });
  }
  if (e.CUSTOM_BASE_URL && e.CUSTOM_API_KEY && e.CUSTOM_MODEL) {
    list.push({
      id: 'custom',
      kind: 'openai',
      label: e.CUSTOM_LABEL ?? '自定义兼容端点',
      baseUrl: e.CUSTOM_BASE_URL,
      apiKey: e.CUSTOM_API_KEY,
      models: splitModels(e.CUSTOM_MODELS, e.CUSTOM_MODEL),
      defaultModel: e.CUSTOM_MODEL,
    });
  }
  return list;
}

/**
 * 新建会话的默认供应商：优先真实供应商，mock 只作最后兜底。
 * mock 的分数/标签/框是按文件名哈希随机生成的，默认落到它身上会让人误以为「AI 严重漂移」，
 * 所以只允许用户主动选择，不再作为默认值。
 */
export function defaultProviderId(providers: ProviderCfg[] = listProviders()): string {
  const real = providers.find((p) => p.kind !== 'mock');
  return (real ?? providers[0])?.id ?? 'mock';
}

export function getProvider(id: string): VisionProvider {
  const cfg = listProviders().find((p) => p.id === id);
  if (!cfg) throw httpErr(400, '该模型供应商不可用或未配置');
  if (cfg.kind === 'mock') return mockProvider;
  return makeOpenAIProvider(cfg);
}
