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

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm">
        {/* 品牌区：mono 小标 + 大标题 + 斜线分隔 */}
        <div className="mb-8 text-center">
          <p className="mono text-muted">AI PHOTO CURATION</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.03em]">📷 Moments</h1>
          <p className="mt-2 text-sm text-ink-soft">AI 帮你挑出发朋友圈的图</p>
        </div>

        <div className="panel p-8">
          {registerOpen ? (
            <div className="mb-6 flex border border-line">
              {(['login', 'register'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setError('');
                  }}
                  className={`flex-1 py-2 text-[13px] font-medium transition-colors duration-300 ${
                    mode === m ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper-2'
                  }`}
                >
                  {m === 'login' ? '登录' : '注册'}
                </button>
              ))}
            </div>
          ) : (
            <h2 className="mb-6 text-center text-sm font-medium text-ink-soft">登录</h2>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="mono mb-2 block text-muted">USERNAME</label>
              <input
                className="field"
                placeholder="用户名（3~20 位字母/数字/下划线）"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div>
              <label className="mono mb-2 block text-muted">PASSWORD</label>
              <input
                className="field"
                type="password"
                placeholder="密码（≥8 位，含字母和数字）"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </div>
            {error && <p className="border-l-2 border-ink pl-2 text-xs text-ink">{error}</p>}
            <button
              type="submit"
              disabled={busy || !username || !password}
              className="btn btn--solid w-full"
            >
              <span>{busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并进入'}</span>
            </button>
          </form>
        </div>

        <p className="mono mt-6 text-center text-muted">MOMENTS · LOCAL FIRST</p>
      </div>
    </div>
  );
}
