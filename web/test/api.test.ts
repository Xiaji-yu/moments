import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TOKEN_KEY, api, apiUpload, authBlob, authBlobPost, getToken, setToken } from '../src/api';

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('token 存取（localStorage）', () => {
  it('setToken(null) 清除；getToken 读回', () => {
    setToken('abc');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('abc');
    expect(getToken()).toBe('abc');
    setToken(null);
    expect(getToken()).toBeNull();
  });
});

describe('api()（统一鉴权与错误处理）', () => {
  it('GET 自动附加 Bearer 头', async () => {
    setToken('tok-1');
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await api('/sessions');
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions');
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('无 token 时不带 Authorization 头', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api('/auth/config');
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.has('Authorization')).toBe(false);
  });

  it('JSON body 自动带 Content-Type；FormData 不覆盖', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api('/sessions/1/select', { method: 'POST', body: JSON.stringify({ n: 9 }) });
    let headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('Content-Type')).toBe('application/json');

    const form = new FormData();
    await api('/upload', { method: 'POST', body: form });
    headers = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(headers.has('Content-Type')).toBe(false); // 交给浏览器生成 boundary
  });

  it('成功时返回解析后的 JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 's1' }));
    expect(await api('/sessions')).toEqual({ id: 's1' });
  });

  it('业务错误抛 ApiError 且消息取自响应体 error 字段', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: '还有照片未完成分析' }));
    const err = await api('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('还有照片未完成分析');
  });

  it('响应体无 error 字段时使用兜底文案', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, null));
    const err = await api('/x').catch((e) => e);
    expect(err.message).toBe('请求失败（500）');
  });

  it('非 login/register 的 401：清除 token、跳转登录页并抛 ApiError（会话过期处理）', async () => {
    setToken('expired');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    fetchMock.mockResolvedValue(jsonResponse(401, {}));
    const err = await api('/sessions').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(getToken()).toBeNull();
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('login 的 401 不触发跳转（正常失败场景）', async () => {
    setToken('should-stay-unrelated');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    fetchMock.mockResolvedValue(jsonResponse(401, { error: '用户名或密码错误' }));
    const err = await api('/auth/login', { method: 'POST', body: '{}' }).catch((e) => e);
    expect(err.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    expect(getToken()).toBe('should-stay-unrelated');
  });
});

describe('authBlob / authBlobPost（鉴权二进制下载）', () => {
  it('authBlob 成功返回 blob，失败抛错', async () => {
    setToken('tok-2');
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    fetchMock.mockResolvedValue(new Response(jpegBytes, { status: 200 }));
    const blob = await authBlob('/photos/p1/thumb');
    expect(await blob.arrayBuffer()).toEqual(jpegBytes.buffer);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-2');

    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(authBlob('/photos/p1/thumb')).rejects.toThrow('图片加载失败');
  });

  it('authBlobPost 发送 JSON 且失败时抛 ApiError', async () => {
    setToken('tok-3');
    fetchMock.mockResolvedValue(new Response(new Blob(['zip']), { status: 200 }));
    const blob = await authBlobPost('/sessions/1/export', { photoIds: ['a'] });
    expect(blob).toBeInstanceOf(Blob);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer tok-3');
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ photoIds: ['a'] }));

    fetchMock.mockResolvedValue(jsonResponse(409, { error: '没有可导出的照片' }));
    const err = await authBlobPost('/sessions/1/export', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('没有可导出的照片');
  });
});

describe('apiUpload（XHR multipart + 上传进度）', () => {
  /** 记录每次 new XMLHttpRequest() 的实例，便于断言与手动触发回调 */
  let instances: FakeXhr[] = [];

  class FakeXhr {
    static create: () => FakeXhr = () => new FakeXhr();
    upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    status = 200;
    responseText = '{"added":2,"failed":[],"duplicates":[]}';
    open = vi.fn();
    setRequestHeader = vi.fn();
    send = vi.fn(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      this.onload?.();
    });

    constructor() {
      instances.push(this);
    }
  }

  beforeEach(() => {
    instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  it('成功时解析 JSON、带 Authorization 头并汇报进度', async () => {
    setToken('tok-up');
    const seen: Array<[number, number]> = [];
    const r = await apiUpload<{ added: number }>('/sessions/s1/photos', new FormData(), (l, t) =>
      seen.push([l, t]),
    );
    expect(r).toEqual({ added: 2, failed: [], duplicates: [] });
    expect(seen).toEqual([[50, 100]]);
    expect(instances[0].open).toHaveBeenCalledWith('POST', '/api/sessions/s1/photos');
    expect(instances[0].setRequestHeader).toHaveBeenCalledWith('Authorization', 'Bearer tok-up');
  });

  it('业务错误抛 ApiError 且消息取自响应体', async () => {
    setToken('tok-up');
    instances = [];
    class FailXhr extends FakeXhr {
      status = 409;
      responseText = '{"error":"单会话最多 30 张"}';
    }
    vi.stubGlobal('XMLHttpRequest', FailXhr);
    const err = await apiUpload('/sessions/s1/photos', new FormData()).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('单会话最多 30 张');
  });

  it('401 时清除 token 并跳转登录页', async () => {
    setToken('expired');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    class UnauthorizedXhr extends FakeXhr {
      status = 401;
      responseText = '{}';
    }
    vi.stubGlobal('XMLHttpRequest', UnauthorizedXhr);
    const err = await apiUpload('/sessions/s1/photos', new FormData()).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(getToken()).toBeNull();
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('网络错误时抛出可读错误', async () => {
    setToken('tok-up');
    class NetworkFailXhr extends FakeXhr {
      send = vi.fn(() => this.onerror?.());
    }
    vi.stubGlobal('XMLHttpRequest', NetworkFailXhr);
    await expect(apiUpload('/sessions/s1/photos', new FormData())).rejects.toThrow('网络错误，上传失败');
  });
});
