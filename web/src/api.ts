export const TOKEN_KEY = 'moments_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');

  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/register') {
    setToken(null);
    window.location.assign('/login');
    throw new ApiError(401, '未登录');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `请求失败（${res.status}）`);
  }
  return data as T;
}

export async function authBlob(path: string): Promise<Blob> {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
  if (!res.ok) throw new Error('图片加载失败');
  return res.blob();
}

/**
 * POST multipart 并汇报上传进度。
 * fetch 不支持 upload progress，这里用 XHR；错误语义与 api() 保持一致。
 */
export function apiUpload<T = unknown>(
  path: string,
  form: FormData,
  onProgress?: (loaded: number, total: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
      } else if (xhr.status === 401) {
        setToken(null);
        window.location.assign('/login');
        reject(new ApiError(401, '未登录'));
      } else {
        reject(new ApiError(xhr.status, (data as { error?: string } | null)?.error ?? `请求失败（${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, '网络错误，上传失败'));
    xhr.send(form);
  });
}

/** POST + 鉴权下载二进制（导出 zip 用） */
export async function authBlobPost(path: string, body: unknown): Promise<Blob> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `导出失败（${res.status}）`);
  }
  return res.blob();
}
