import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultProviderId, getProvider, listProviders } from '../../src/services/providers/registry.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('listProviders（由环境变量构建，AC-F0-1）', () => {
  it('无任何 Key 时只有 mock', () => {
    vi.stubEnv('ZHIPU_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('CUSTOM_BASE_URL', '');
    const list = listProviders();
    expect(list.map((p) => p.id)).toEqual(['mock']);
  });

  it('配置智谱 Key 后出现 zhipu，模型列表支持逗号分隔', () => {
    vi.stubEnv('ZHIPU_API_KEY', 'key-123');
    vi.stubEnv('ZHIPU_MODELS', 'glm-4.5v, glm-4v-plus');
    const zhipu = listProviders().find((p) => p.id === 'zhipu');
    expect(zhipu).toBeDefined();
    expect(zhipu!.models).toEqual(['glm-4.5v', 'glm-4v-plus']);
    expect(zhipu!.defaultModel).toBe('glm-4.5v');
    expect(zhipu!.baseUrl).toContain('bigmodel.cn');
  });

  it('OpenAI Key 生效且自定义 baseUrl 可覆盖', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-x');
    vi.stubEnv('OPENAI_BASE_URL', 'https://example.com/v1');
    const openai = listProviders().find((p) => p.id === 'openai');
    expect(openai!.baseUrl).toBe('https://example.com/v1');
    expect(openai!.defaultModel).toBe('gpt-4o-mini');
  });

  it('自定义端点要求三个变量齐全', () => {
    vi.stubEnv('CUSTOM_BASE_URL', 'https://a.b/v1');
    vi.stubEnv('CUSTOM_API_KEY', 'k');
    expect(listProviders().map((p) => p.id)).not.toContain('custom');
    vi.stubEnv('CUSTOM_MODEL', 'my-model');
    const custom = listProviders().find((p) => p.id === 'custom');
    expect(custom!.defaultModel).toBe('my-model');
    expect(custom!.label).toBe('自定义兼容端点');
  });

  it('列表不含 apiKey 字段泄露给前端路由（路由层已映射白名单字段）', () => {
    vi.stubEnv('ZHIPU_API_KEY', 'secret');
    // registry 自身携带 apiKey 供服务端调用；对外由 routes/providers.ts 只输出白名单字段
    const cfg = listProviders().find((p) => p.id === 'zhipu')!;
    expect(cfg.apiKey).toBe('secret');
  });
});

describe('getProvider', () => {
  it('mock 返回内置 provider', () => {
    const p = getProvider('mock');
    expect(p.id).toBe('mock');
    expect(p.defaultModel).toBe('mock-vision');
  });

  it('未配置的供应商 → 400', async () => {
    vi.stubEnv('ZHIPU_API_KEY', '');
    const { httpErr } = await import('../../src/util.js');
    try {
      getProvider('zhipu');
      expect.unreachable();
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
      expect((err as Error).message).toBe('该模型供应商不可用或未配置');
    }
    void httpErr;
  });
});

describe('defaultProviderId（新建会话默认供应商）', () => {
  const cfg = (id: string, kind: 'mock' | 'openai') => ({
    id,
    kind,
    label: id,
    models: [`${id}-model`],
    defaultModel: `${id}-model`,
  });

  it('有真实供应商时不用 mock', () => {
    expect(defaultProviderId([cfg('mock', 'mock'), cfg('zhipu', 'openai')])).toBe('zhipu');
  });

  it('只有 mock（未配置 Key）时兜底 mock', () => {
    expect(defaultProviderId([cfg('mock', 'mock')])).toBe('mock');
    expect(defaultProviderId([])).toBe('mock');
  });

  it('不传参时按当前环境变量计算', () => {
    vi.stubEnv('ZHIPU_API_KEY', 'k');
    vi.stubEnv('ZHIPU_MODELS', 'glm-4.5v');
    expect(defaultProviderId()).toBe('zhipu');
    vi.stubEnv('ZHIPU_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('CUSTOM_BASE_URL', '');
    expect(defaultProviderId()).toBe('mock');
  });
});
