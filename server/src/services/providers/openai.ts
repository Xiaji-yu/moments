import { SYSTEM_PROMPT, USER_PROMPT } from '../prompts.js';
import type { ProviderCfg } from './registry.js';
import type { AnalyzeInput, VisionProvider } from './types.js';

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
 * 通用 OpenAI-compatible 视觉 Provider（chat/completions + image_url）。
 * 智谱 GLM / OpenAI / 任何兼容端点均可通过配置接入（NFR-8）。
 */
export function makeOpenAIProvider(cfg: ProviderCfg): VisionProvider {
  const baseUrl = cfg.baseUrl!.replace(/\/+$/, '');

  async function call(
    model: string,
    imageBase64: string,
    mime: string,
    userText: string,
    jsonMode: boolean,
  ): Promise<Response> {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
          { type: 'text', text: userText },
        ],
      },
    ];
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

  return {
    id: cfg.id,
    label: cfg.label,
    models: cfg.models,
    defaultModel: cfg.defaultModel,
    async analyzePhoto({ imageBase64, mime, model, corrective }: AnalyzeInput) {
      const userText = corrective ? `${corrective}\n${USER_PROMPT}` : USER_PROMPT;
      const useModel = model || cfg.defaultModel;

      // AC-F10-2：429 指数退避重试（1s/2s/4s）
      let res = await call(useModel, imageBase64, mime, userText, true);
      for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
        await sleep(1000 * 2 ** attempt);
        res = await call(useModel, imageBase64, mime, userText, true);
      }
      // 部分端点不支持 response_format，降级重试
      if (res.status === 400) {
        res = await call(useModel, imageBase64, mime, userText, false);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        const hint =
          res.status === 401
            ? '（API Key 无效）'
            : res.status === 429
              ? '（触发供应商限流）'
              : '';
        throw new Error(`模型请求失败 ${res.status}${hint}${detail ? `：${detail}` : ''}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      return extractJson(content);
    },
  };
}
