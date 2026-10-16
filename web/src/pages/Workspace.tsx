import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setToken } from '../api';
import type {
  Photo,
  PhotoStatus,
  Progress,
  ProviderInfo,
  SelectResult,
  SessionDetail,
  SessionInfo,
} from '../types';
import { PhotoThumb } from '../components/PhotoThumb';

const statusMeta: Record<PhotoStatus, { label: string; cls: string }> = {
  ready: { label: '待分析', cls: 'bg-gray-100 text-gray-500' },
  analyzing: { label: '分析中', cls: 'bg-blue-100 text-blue-600 animate-pulse' },
  done: { label: '完成', cls: 'bg-green-100 text-green-700' },
  failed: { label: '失败', cls: 'bg-red-100 text-red-600' },
};

const rejectCls: Record<string, string> = {
  重复: 'bg-orange-50 text-orange-600',
  质量问题: 'bg-red-50 text-red-500',
  内容平淡: 'bg-gray-100 text-gray-500',
};

export default function Workspace() {
  const [me, setMe] = useState('');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [n, setN] = useState(9);
  const [result, setResult] = useState<SelectResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  const loadSession = useCallback(async (id: string) => {
    const d = await api<SessionDetail>(`/sessions/${id}`);
    setSessionId(d.session.id);
    setPhotos(d.photos);
    if (d.session.provider) setProviderId(d.session.provider);
    if (d.session.model) setModel(d.session.model);
    return d;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const meInfo = await api<{ username: string }>('/auth/me');
        setMe(meInfo.username);
        const provs = (await api<{ providers: ProviderInfo[] }>('/providers')).providers;
        setProviders(provs);
        setProviderId((prev) => prev || provs[0]?.id || '');
        setModel((prev) => prev || provs[0]?.defaultModel || '');
        const saved = localStorage.getItem('moments_session');
        if (saved) {
          try {
            await loadSession(saved);
            return;
          } catch {
            localStorage.removeItem('moments_session');
          }
        }
        const s = await api<SessionInfo>('/sessions', { method: 'POST', body: '{}' });
        localStorage.setItem('moments_session', s.id);
        setSessionId(s.id);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [loadSession]);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    },
    [],
  );

  function stopPoll() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function switchProvider(id: string) {
    setProviderId(id);
    const p = providers.find((x) => x.id === id);
    if (p) setModel(p.defaultModel);
  }

  async function uploadFiles(files: File[]) {
    if (!files.length || !sessionId) return;
    setUploading(true);
    setError('');
    setNotice('');
    try {
      const fd = new FormData();
      files.slice(0, 60).forEach((f) => fd.append('files', f));
      const r = await api<{ added: number; failed: { filename: string; reason: string }[]; duplicates: string[] }>(
        `/sessions/${sessionId}/photos`,
        { method: 'POST', body: fd },
      );
      await loadSession(sessionId);
      const msgs: string[] = [];
      if (r.duplicates.length) msgs.push(`跳过重复 ${r.duplicates.length} 张`);
      if (r.failed.length) msgs.push(`失败 ${r.failed.length} 张：${r.failed[0].reason}${r.failed.length > 1 ? ' 等' : ''}`);
      setNotice(`导入完成：成功 ${r.added} 张${msgs.length ? '，' + msgs.join('；') : ''}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function startAnalyze() {
    if (!sessionId || !photos.length) return;
    setBusy(true);
    setError('');
    setNotice('');
    setResult(null);
    try {
      await api(`/sessions/${sessionId}/analyze`, {
        method: 'POST',
        body: JSON.stringify({ provider: providerId, model }),
      });
      setAnalyzing(true);
      stopPoll();
      timerRef.current = window.setInterval(async () => {
        try {
          const p = await api<Progress>(`/sessions/${sessionId}/progress`);
          setProgress(p);
          if (!p.running && p.analyzing === 0) {
            stopPoll();
            setAnalyzing(false);
            await loadSession(sessionId);
            setNotice(`分析完成：成功 ${p.done} 张${p.failed ? `，失败 ${p.failed} 张（可重新点分析只跑失败项）` : ''}`);
          }
        } catch {
          stopPoll();
          setAnalyzing(false);
        }
      }, 1000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelAnalyze() {
    try {
      await api(`/sessions/${sessionId}/analyze/cancel`, { method: 'POST' });
    } catch {
      // 忽略
    }
  }

  async function pick() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await api<SelectResult>(`/sessions/${sessionId}/select`, {
        method: 'POST',
        body: JSON.stringify({ n }),
      });
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(id: string) {
    try {
      await api(`/sessions/${sessionId}/photos/${id}`, { method: 'DELETE' });
      await loadSession(sessionId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // 忽略
    }
    setToken(null);
    localStorage.removeItem('moments_session');
    window.location.assign('/login');
  }

  const analyzedAll = photos.length > 0 && photos.every((p) => p.status === 'done');
  const progressPct = progress && progress.total ? Math.round(((progress.done + progress.failed) / progress.total) * 100) : 0;
  const currentModels = providers.find((p) => p.id === providerId)?.models ?? [];
  const selectCls =
    'rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500';

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <span className="text-lg font-bold">📷 Moments</span>
          <span className="hidden text-sm text-gray-400 sm:inline">AI 朋友圈选图</span>
          <div className="flex-1" />
          <select value={providerId} onChange={(e) => switchProvider(e.target.value)} className={selectCls}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)} className={`${selectCls} hidden sm:block`}>
            {currentModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span className="hidden text-sm text-gray-500 md:inline">{me}</span>
          <button onClick={logout} className="text-sm text-gray-400 transition hover:text-gray-700">
            退出
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}
        {notice && !analyzing && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void uploadFiles(Array.from(e.dataTransfer.files));
          }}
          onClick={() => fileRef.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition ${
            dragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.heic,.heif"
            className="hidden"
            onChange={(e) => void uploadFiles(Array.from(e.target.files ?? []))}
          />
          <p className="text-gray-600">
            {uploading ? '上传处理中…' : '拖拽照片到这里，或点击选择（单次 ≤ 30 张，支持 iPhone HEIC / JPG / PNG / WebP）'}
          </p>
          <p className="mt-1 text-xs text-gray-400">拍摄时间、连拍信息只用于排序与聚类，GPS 等隐私数据不会保留</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void startAnalyze()}
            disabled={!photos.length || analyzing || busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-40"
          >
            {analyzing ? '分析中…' : `开始 AI 分析（${photos.length} 张）`}
          </button>
          {analyzing && (
            <button
              onClick={() => void cancelAnalyze()}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50"
            >
              取消
            </button>
          )}
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">推荐张数</label>
            <select value={n} onChange={(e) => setN(Number(e.target.value))} className={selectCls}>
              {[1, 3, 4, 6, 9].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => void pick()}
            disabled={!analyzedAll || analyzing || busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-40"
          >
            AI 挑图
          </button>
          {analyzing && progress && (
            <div className="min-w-48 flex-1">
              <div className="h-2 overflow-hidden rounded-full bg-gray-200">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {progress.done + progress.failed}/{progress.total}
                {progress.failed ? ` · 失败 ${progress.failed}` : ''}
              </p>
            </div>
          )}
        </div>

        {photos.length === 0 ? (
          <p className="py-10 text-center text-gray-400">还没有照片，先导入一批吧</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {photos.map((p) => (
              <div key={p.id} className="group relative overflow-hidden rounded-lg border border-gray-200 bg-white">
                <div className="aspect-square">
                  <PhotoThumb photoId={p.id} />
                </div>
                <button
                  onClick={() => void removePhoto(p.id)}
                  title="删除"
                  className="absolute top-1 right-1 hidden h-6 w-6 items-center justify-center rounded-full bg-black/50 text-xs text-white group-hover:flex"
                >
                  ×
                </button>
                <div className="px-2 py-1.5">
                  <p className="truncate text-xs text-gray-500" title={p.filename}>
                    {p.filename}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${statusMeta[p.status].cls}`}>
                      {statusMeta[p.status].label}
                    </span>
                    {p.analysis && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                        {p.analysis.score} 分
                      </span>
                    )}
                    {p.analysis?.issues.map((i) => (
                      <span key={i} className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-500">
                        {i}
                      </span>
                    ))}
                  </div>
                  {p.status === 'failed' && p.error && (
                    <p className="mt-1 line-clamp-2 text-[11px] text-red-400" title={p.error}>
                      {p.error}
                    </p>
                  )}
                  {p.analysis && <p className="mt-1 line-clamp-2 text-[11px] text-gray-500">{p.analysis.reason}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        {result && (
          <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="font-semibold">🏆 AI 推荐 {result.selected.length} 张</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
              {result.selected.map((s) => (
                <div key={s.photoId} className="overflow-hidden rounded-lg border border-gray-200">
                  <div className="relative aspect-square">
                    <PhotoThumb photoId={s.photoId} />
                    <span className="absolute top-1 left-1 flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-medium text-white">
                      {s.order}
                    </span>
                  </div>
                  <p className="line-clamp-3 p-2 text-[11px] text-gray-600">{s.reason}</p>
                </div>
              ))}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-gray-700">落选照片（{result.rejected.length}）</h3>
              <ul className="space-y-1">
                {result.rejected.map((r) => (
                  <li key={r.photoId} className="flex items-center gap-2 text-xs text-gray-600">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${rejectCls[r.category] ?? rejectCls['内容平淡']}`}>
                      {r.category}
                    </span>
                    <span className="max-w-48 truncate">{r.filename}</span>
                    <span className="text-gray-400">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
