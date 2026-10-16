export interface HttpError extends Error {
  statusCode: number;
  /** 明确可展示给用户的文案；未设置时按 statusCode 决定是否透传 message */
  publicMessage?: string;
}

export function httpErr(statusCode: number, message: string, publicMessage?: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  if (publicMessage) err.publicMessage = publicMessage;
  return err;
}

/**
 * 统一错误响应给用户看的内容：
 * - 有 publicMessage 直接用；
 * - 4xx 业务错误的 message 本身就是给用户看的中文，透传；
 * - 其余（5xx / 无 statusCode / 框架错误）一律通用文案，避免泄露内部细节。
 */
export function responseMessage(err: unknown): string {
  const e = err as Partial<HttpError> | null | undefined;
  if (e?.publicMessage) return e.publicMessage;
  if (typeof e?.statusCode === 'number' && e.statusCode > 0 && e.statusCode < 500) return e.message ?? '请求失败';
  return '服务器内部错误';
}

/**
 * 把模型调用抛出的错误归类成用户可读短句（不泄露供应商返回的原始 detail）。
 * 主要消费方是 pipeline：写进 photos.error 展示在照片卡片上。
 */
export function userFacingError(err: unknown): string {
  const e = err as (Error & { name?: string }) | null | undefined;
  const msg = String(e?.message ?? err ?? '');
  if (e?.name === 'TimeoutError' || /timeout|超时|aborted/i.test(msg)) return '模型响应超时，请重试';
  if (/429|限流|rate.?limit/i.test(msg)) return '供应商限流，请稍后重试';
  if (/401|API Key 无效|鉴权失败/i.test(msg)) return '模型 Key 无效，请检查供应商配置';
  if (/fetch failed|ECONN|ENOTFOUND|socket hang up|网络/i.test(msg)) return '网络错误，请检查供应商连通性';
  if (/解析 JSON|不符合约定格式|输出格式/.test(msg)) return '模型输出格式异常，请重试';
  if (/模型请求失败/.test(msg)) return '模型请求失败，请稍后重试';
  return '处理失败，请重试';
}
