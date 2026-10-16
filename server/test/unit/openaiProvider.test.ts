import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeOpenAIProvider } from '../../src/services/providers/openai.js';
import type { ProviderCfg } from '../../src/services/providers/registry.js';

const cfg: ProviderCfg = {
  id: 'test',
  kind: 'openai',
  label: 'Test',
  baseUrl: 'https://api.test/v1',
  apiKey: 'key-123',
  models: ['m1'],
  defaultModel: 'm1',
};

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const chatOk = (content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({
  choices: [{ message: { content } }],
  usage,
});

const analyzeInput = { imageBase64: 'AAA', mime: 'image/jpeg', model: 'm1' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('makeOpenAIProvider（OpenAI-compatible 客户端）', () => {
  it('解析 JSON、提取 usage，并带上 json_mode 与图片 data url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRes(chatOk('{"score":7,"tags":["海边"],"issues":[],"reason":"不错"}')));
    vi.stubGlobal('fetch', fetchMock);

    const r = await makeOpenAIProvider(cfg).analyzePhoto(analyzeInput);
    expect(r.data).toEqual({ score: 7, tags: ['海边'], issues: [], reason: '不错' });
    expect(r.usage).toEqual({ input: 10, output: 5 });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer key-123');
    const body = JSON.parse(init.body);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content[0].image_url.url).toBe('data:image/jpeg;base64,AAA');
  });

  it('从 ``` 代码块中提取 JSON（模型不肯裸输出时）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(chatOk('```json\n{"a":1}\n```'))));
    const r = await makeOpenAIProvider(cfg).analyzePhoto(analyzeInput);
    expect(r.data).toEqual({ a: 1 });
  });

  it('corrective 指令拼在 user 文本前（AC-F3-4）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(chatOk('{"a":1}')));
    vi.stubGlobal('fetch', fetchMock);
    await makeOpenAIProvider(cfg).analyzePhoto({ ...analyzeInput, corrective: '请只输出 JSON' });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.messages[1].content[1].text).toContain('请只输出 JSON');
  });

  it('429 时指数退避重试后成功（AC-F10-2）', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValue(jsonRes(chatOk('{"ok":true}')));
    vi.stubGlobal('fetch', fetchMock);

    const promise = makeOpenAIProvider(cfg).analyzePhoto(analyzeInput);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await promise).data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('400（端点不支持 response_format）时降级为普通模式重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad request', { status: 400 }))
      .mockResolvedValueOnce(jsonRes(chatOk('{"ok":1}')));
    vi.stubGlobal('fetch', fetchMock);

    const r = await makeOpenAIProvider(cfg).analyzePhoto(analyzeInput);
    expect(r.data).toEqual({ ok: 1 });
    const second = JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body);
    expect(second.response_format).toBeUndefined();
  });

  it('持续 429 后抛错，消息含状态码', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const promise = makeOpenAIProvider(cfg).analyzePhoto(analyzeInput);
    const assertion = expect(promise).rejects.toThrow(/429/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('401 时错误消息提示 Key 无效', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
    await expect(makeOpenAIProvider(cfg).analyzePhoto(analyzeInput)).rejects.toThrow(/API Key 无效/);
  });

  it('无法解析 JSON 时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(chatOk('完全不是 JSON'))));
    await expect(makeOpenAIProvider(cfg).analyzePhoto(analyzeInput)).rejects.toThrow(
      '无法从模型输出中解析 JSON',
    );
  });

  it('generateCaptions 是纯文本调用：不传图、取 captions 数组（AC-F7-1）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(chatOk('{"captions":["一","二","三"]}')));
    vi.stubGlobal('fetch', fetchMock);

    const r = await makeOpenAIProvider(cfg).generateCaptions({
      model: 'm1',
      tags: ['海边'],
      reasons: ['不错'],
      style: '简洁',
    });
    expect(r.data).toEqual(['一', '二', '三']);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(typeof body.messages[1].content).toBe('string');
    expect(JSON.stringify(body)).not.toContain('image_url');
  });
});
