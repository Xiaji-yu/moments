import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api';

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(true);

  useEffect(() => {
    api<{ registerEnabled: boolean }>('/auth/config')
      .then((c) => setRegisterOpen(c.registerEnabled))
      .catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string }>(`/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(r.token);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input =
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-center text-2xl font-bold">📷 Moments</h1>
        <p className="mt-1 text-center text-sm text-gray-400">AI 帮你挑出发朋友圈的图</p>

        {registerOpen ? (
          <div className="mt-6 grid grid-cols-2 rounded-lg bg-gray-100 p-1 text-sm">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError('');
                }}
                className={`rounded-md py-1.5 transition ${
                  mode === m ? 'bg-white font-medium shadow-sm' : 'text-gray-500'
                }`}
              >
                {m === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>
        ) : (
          <h2 className="mt-6 text-center text-sm font-medium text-gray-600">登录</h2>
        )}

        <form onSubmit={submit} className="mt-4 space-y-3">
          <input
            className={input}
            placeholder="用户名（3~20 位字母/数字/下划线）"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            className={input}
            type="password"
            placeholder="密码（≥8 位，含字母和数字）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={busy || !username || !password}
            className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并进入'}
          </button>
        </form>
      </div>
    </div>
  );
}
