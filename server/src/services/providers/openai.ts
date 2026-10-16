import { CROP_SYSTEM_PROMPT, CROP_USER_PROMPT, SYSTEM_PROMPT, USER_PROMPT } from '../prompts.js';
import type { ProviderCfg } from './registry.js';
import type {
  AnalyzeInput,
  CaptionInput,
  ProviderResult,
  SuggestCropInput,
  TokenUsage,
  VisionProvider,
} from './types.js';

function extractJson(text: string): unknown {
  const candidates = [text, ...text.split('```')];
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(c.slice(start, end + 1));
      } catch {
        // 尝试下一个候选
      }
    }
  }
  throw new Error('无法从模型输出中解析 JSON');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 通用 OpenAI-compatible Provider（chat/completions）。
 * 智谱 GLM / OpenAI / 任何兼容端点均可通过配置接入（NFR-8）。
 */
export function makeOpenAIProvider(cfg: ProviderCfg): VisionProvider {
  const baseUrl = cfg.baseUrl!.replace(/\/+$/, '');

  async function call(model: string, messages: unknown, jsonMode: boolean): Promise<Response> {
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
  }

  function extractUsage(data: unknown): TokenUsage | undefined {
    const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
    if (!usage) return undefined;
    return { input: usage.prompt_tokens, output: usage.completion_tokens };
  }

  /** 发起请求：429 指数退避（AC-F10-2）、json_mode 400 降级、解析 JSON + usage */
  async function chat(
    model: string,
    messages: unknown,
    imageDataUrl?: string,
    userTextExtra?: string,
  ): Promise<ProviderResult<unknown>> {
    const useModel = model || cfg.defaultModel;
    const content = imageDataUrl
      ? [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: userTextExtra ?? '' },
        ]
      : userTextExtra ?? '';
    const messagesWithContent = [
      { role: 'system', content: messages as string },
      { role: 'user', content },
    ];

    let res = await call(useModel, messagesWithContent, true);
    for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
      await sleep(1000 * 2 ** attempt);
      res = await call(useModel, messagesWithContent, true);
    }
    // 部分端点不支持 response_format，降级重试
    if (res.status === 400) {
      res = await call(useModel, messagesWithContent, false);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      const hint = res.status === 401 ? '（API Key 无效）' : res.status === 429 ? '（触发供应商限流）' : '';
      throw new Error(`模型请求失败 ${res.status}${hint}${detail ? `：${detail}` : ''}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = data.choices?.[0]?.message?.content ?? '';
    return { data: extractJson(raw), usage: extractUsage(data) };
  }

  return {
    id: cfg.id,
    label: cfg.label,
    models: cfg.models,
    defaultModel: cfg.defaultModel,

    async analyzePhoto({ imageBase64, mime, model, corrective }: AnalyzeInput) {
      const userText = corrective ? `${corrective}\n${USER_PROMPT}` : USER_PROMPT;
      return chat(model || cfg.defaultModel, SYSTEM_PROMPT, `data:${mime};base64,${imageBase64}`, userText);
    },

    async suggestCrop({ imageBase64, mime, model, corrective }: SuggestCropInput) {
      const userText = corrective ? `${corrective}\n${CROP_USER_PROMPT}` : CROP_USER_PROMPT;
      return chat(model || cfg.defaultModel, CROP_SYSTEM_PROMPT, `data:${mime};base64,${imageBase64}`, userText);
    },

    async generateCaptions({ model, tags, reasons, style, note, corrective }: CaptionInput): Promise<ProviderResult<string[]>> {
      const system = `你是朋友圈文案写手。根据提供的照片内容信息撰写朋友圈文案，只输出一个 JSON 对象：{"captions": ["文案1", "文案2", "文案3"]}。
要求：每条不超过 6 行；适当使用 emoji；内容必须与照片场景标签相关；${style === '混合' ? '三条文案风格分别为：简洁、文艺、搞笑。' : `三条文案均为「${style}」风格。`}`;
      const user = [
        tags.length ? `照片内容标签：${tags.join('、')}` : '',
        reasons.length ? `照片简评：${reasons.join('；')}` : '',
        note ? `用户补充：${note}` : '',
        corrective ?? '请生成 3 条文案，按约定只输出 JSON。',
      ]
        .filter(Boolean)
        .join('\n');
      // 纯文本调用，不传图（AC-F7-1）
      const result = await chat(model || cfg.defaultModel, system, undefined, user);
      return { data: (result.data as { captions?: string[] }).captions ?? [], usage: result.usage };
    },
  };
}
