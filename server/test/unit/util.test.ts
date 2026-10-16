import { describe, expect, it } from 'vitest';
import { httpErr, responseMessage, userFacingError } from '../../src/util.js';

describe('httpErr', () => {
  it('创建带 statusCode 的 Error', () => {
    const err = httpErr(404, '会话不存在');
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('会话不存在');
  });

  it('可附加 publicMessage', () => {
    const err = httpErr(429, '内部详情', '今天额度用完了');
    expect(err.publicMessage).toBe('今天额度用完了');
  });
});

describe('responseMessage（错误响应卫生）', () => {
  it('4xx 业务错误透传 message', () => {
    expect(responseMessage(httpErr(409, '还有照片未完成分析'))).toBe('还有照片未完成分析');
  });

  it('publicMessage 优先', () => {
    expect(responseMessage(httpErr(429, '内部', '请明天再试'))).toBe('请明天再试');
  });

  it('5xx / 无 statusCode 的错误只回通用文案', () => {
    expect(responseMessage(new Error('ECONNREFUSED 10.0.0.1:443'))).toBe('服务器内部错误');
    expect(responseMessage(httpErr(502, '上游炸了'))).toBe('服务器内部错误');
    expect(responseMessage(null)).toBe('服务器内部错误');
  });
});

describe('userFacingError（模型错误归类）', () => {
  it('超时', () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    expect(userFacingError(err)).toBe('模型响应超时，请重试');
  });

  it('限流 / Key 无效 / 网络 / 格式各有可读文案', () => {
    expect(userFacingError(new Error('模型请求失败 429（触发供应商限流）'))).toBe('供应商限流，请稍后重试');
    expect(userFacingError(new Error('模型请求失败 401（API Key 无效）'))).toBe('模型 Key 无效，请检查供应商配置');
    expect(userFacingError(new Error('fetch failed'))).toBe('网络错误，请检查供应商连通性');
    expect(userFacingError(new Error('模型输出不符合约定格式'))).toBe('模型输出格式异常，请重试');
  });

  it('不透传供应商原始 detail', () => {
    const msg = userFacingError(new Error('模型请求失败 500：{"error":{"code":"internal","message":"xxx"}}'));
    expect(msg).not.toContain('internal');
    expect(msg).toBe('模型请求失败，请稍后重试');
  });

  it('未知错误给兜底文案', () => {
    expect(userFacingError(new Error('some weird stuff'))).toBe('处理失败，请重试');
    expect(userFacingError(undefined)).toBe('处理失败，请重试');
  });
});
