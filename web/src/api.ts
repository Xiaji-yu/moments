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
