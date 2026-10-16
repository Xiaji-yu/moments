import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiUpload, authBlobPost, setToken } from '../api';
import type {
  CropProgress,
  Photo,
  PhotoStatus,
  Progress,
  ProviderInfo,
  SelectResult,
  SessionDetail,
  SessionInfo,
  UsageSummary,
} from '../types';
import { PhotoThumb } from '../components/PhotoThumb';
import { CropModal } from '../components/CropModal';
import { CaptionPanel } from '../components/CaptionPanel';
import { LayoutPreview } from '../components/LayoutPreview';
import { FeedbackButtons } from '../components/FeedbackButtons';
import { SessionSidebar } from '../components/SessionSidebar';

/* 状态徽标：空心 / 实心 / 描边 / 反色 四档墨色编码 */
const statusMeta: Record<PhotoStatus, { label: string; cls: string }> = {
  ready: { label: '待分析', cls: 'border border-line-soft text-muted' },
  analyzing: { label: '分析中', cls: 'border-2 border-ink text-ink animate-pulse' },
  done: { label: '完成', cls: 'border border-ink text-ink' },
  failed: { label: '失败', cls: 'bg-ink text-paper' },
};

/* 落选原因：三档墨色编码 */
const rejectCls: Record<string, string> = {
  重复: 'bg-ink text-paper',
  质量问题: 'border border-ink text-ink',
  内容平淡: 'border border-line-soft text-muted',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function Workspace() {
  const [me, setMe] = useState('');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [n, setN] = useState(9);
  const [result, setResult] = useState<SelectResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [cropId, setCropId] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [cropProgress, setCropProgress] = useState<CropProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  const cropTimerRef = useRef<number | null>(null);

  const loadSession = useCallback(async (id: string) => {
    const d = await api<SessionDetail>(`/sessions/${id}`);
    setSessionId(d.session.id);
    setPhotos(d.photos);
    if (d.session.provider) setProviderId(d.session.provider);
    if (d.session.model) setModel(d.session.model);
    return d;
  }, []);

  const fetchUsage = useCallback(async (id: string) => {
    try {
      setUsage(await api<UsageSummary>(`/sessions/${id}/usage`));
    } catch {
      // 用量显示失败不影响主流程
    }
  }, []);

  /** 切换会话（空 id = 原会话已被删除，代为新建）；同时清理进行中的轮询与流程态 */
  const switchSession = useCallback(
    async (id: string) => {
      stopPoll();
      stopCropPoll();
      setAnalyzing(false);
      setSuggesting(false);
      setProgress(null);
      setCropProgress(null);
      setResult(null);
      setError('');
      setNotice('');
      if (!id) {
        const s = await api<SessionInfo>('/sessions', { method: 'POST', body: '{}' });
        localStorage.setItem('moments_session', s.id);
        setSessionId(s.id);
        setPhotos([]);
        setProviderId(s.provider);
        setModel(s.model ?? '');
        void fetchUsage(s.id);
        return;
      }
      localStorage.setItem('moments_session', id);
      setSessionId(id);
      await loadSession(id);
      void fetchUsage(id);
    },
    [loadSession, fetchUsage],
  );

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
            void fetchUsage(saved);
            return;
          } catch {
            localStorage.removeItem('moments_session');
          }
        }
        // 恢复用户最近的会话（NFR-13 会话恢复），没有才新建
        const list = await api<{ sessions: SessionInfo[] }>('/sessions');
        if (list.sessions.length > 0) {
          await switchSession(list.sessions[0].id);
          return;
        }
        const s = await api<SessionInfo>('/sessions', { method: 'POST', body: '{}' });
        localStorage.setItem('moments_session', s.id);
        setSessionId(s.id);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [loadSession, fetchUsage, switchSession]);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (cropTimerRef.current) window.clearInterval(cropTimerRef.current);
    },
    [],
  );

  function stopPoll() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function stopCropPoll() {
    if (cropTimerRef.current) {
      window.clearInterval(cropTimerRef.current);
      cropTimerRef.current = null;
    }
  }

  function switchProvider(id: string) {
    setProviderId(id);
    const p = providers.find((x) => x.id === id);
    if (p) setModel(p.defaultModel);
  }

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    if (!sessionId) {
      setError('会话正在初始化，请稍候再试');
      return;
    }
    setUploading(true);
    setUploadPct(0);
    setError('');
    setNotice('');
    try {
      const fd = new FormData();
      files.slice(0, 60).forEach((f) => fd.append('files', f));
      const r = await apiUpload<{
        added: number;
        failed: { filename: string; reason: string }[];
        duplicates: string[];
      }>(`/sessions/${sessionId}/photos`, fd, (loaded, total) =>
        setUploadPct(total ? Math.round((loaded / total) * 100) : null),
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
      setUploadPct(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function startAnalyze(opts: { retryFailed?: boolean } = {}) {
    if (!sessionId || !photos.length) return;
    setBusy(true);
    setError('');
    setNotice('');
    setResult(null);
    try {
      await api(`/sessions/${sessionId}/analyze`, {
        method: 'POST',
        body: JSON.stringify({
          provider: providerId,
          model,
          ...(opts.retryFailed ? { retryFailed: true } : {}),
        }),
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
            void fetchUsage(sessionId);
            setNotice(
              `分析完成：成功 ${p.done} 张${
                p.failed ? `，失败 ${p.failed} 张（可点照片上的「重试」，或用「重试失败项」批量重跑）` : ''
              }`,
            );
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

  /** 单张重试：同步等待服务端结果 */
  async function retryPhoto(id: string) {
    setRetryingId(id);
    setError('');
    try {
      const r = await api<{ status: string; error: string | null }>(`/photos/${id}/analyze`, {
        method: 'POST',
        body: '{}',
      });
      await loadSession(sessionId);
      void fetchUsage(sessionId);
      setNotice(r.status === 'done' ? '重试完成 ✅' : `重试失败：${r.error ?? '未知原因'}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRetryingId(null);
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

  function setFeedback(photoId: string, v: number) {
    setPhotos((prev) =>
      prev.map((p) =>
        p.id === photoId && p.analysis ? { ...p, analysis: { ...p.analysis, feedback: v } } : p,
      ),
    );
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

  /** 批量生成构图建议 + 轮询进度（AC-F6-1）。
   *  有 AI 推荐结果时只给推荐的若干张生成，否则为全部已完成分析的照片生成。 */
  async function suggestCrops() {
    if (!sessionId) return;
    setError('');
    setNotice('');
    const targetIds = result ? result.selected.map((s) => s.photoId) : null;
    try {
      await api(`/sessions/${sessionId}/crop-suggest`, {
        method: 'POST',
        body: JSON.stringify(targetIds ? { photoIds: targetIds } : {}),
      });
      setSuggesting(true);
      stopCropPoll();
      cropTimerRef.current = window.setInterval(async () => {
        try {
          const p = await api<CropProgress>(`/sessions/${sessionId}/crop-progress`);
          setCropProgress(p);
          if (!p.running && p.done >= p.total) {
            stopCropPoll();
            setSuggesting(false);
            await loadSession(sessionId);
            void fetchUsage(sessionId);
            setNotice(
              p.cancelled
                ? `已取消构图建议（完成 ${p.done}/${p.total} 张）`
                : p.total === 0
                  ? targetIds
                    ? '推荐照片都已有构图建议'
                    : '所有已完成分析的照片都已有构图建议'
                  : `构图建议完成（${p.done} 张${targetIds ? '，限定 AI 推荐照片' : ''}）`,
            );
          }
        } catch {
          stopCropPoll();
          setSuggesting(false);
        }
      }, 800);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function cancelCrops() {
    try {
      await api(`/sessions/${sessionId}/crop-suggest/cancel`, { method: 'POST', body: '{}' });
    } catch {
      // 忽略：下一轮轮询会拿到 cancelled 状态
    }
  }

  /** 导出 zip：可指定顺序（九宫格排版顺序），否则用推荐结果/全部已完成（AC-F9-1/2/4） */
  async function exportZip(ids?: string[]) {
    const exportIds =
      ids ??
      (result
        ? result.selected.map((s) => s.photoId)
        : photos.filter((p) => p.status === 'done').map((p) => p.id));
    if (!exportIds.length) {
      setError('没有可导出的照片');
      return;
    }
    setExporting(true);
    setError('');
    try {
      const blob = await authBlobPost(`/sessions/${sessionId}/export`, { photoIds: exportIds });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `moments-${sessionId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${exportIds.length} 张（已应用二次构图的按裁剪成图打包）`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  /** 导出单张网格拼图（朋友圈单图发布的最终产物，AC-F8） */
  async function exportGrid(ids?: string[]) {
    const exportIds =
      ids ??
      (result
        ? result.selected.map((s) => s.photoId)
        : photos.filter((p) => p.status === 'done').map((p) => p.id));
    if (!exportIds.length) {
      setError('没有可导出的照片');
      return;
    }
    setExporting(true);
    setError('');
    try {
      const blob = await authBlobPost(`/sessions/${sessionId}/export-grid`, {
        photoIds: exportIds,
        cols: 3,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `moments-grid-${sessionId}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出拼图（${exportIds.length} 张，九宫格大图）`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const analyzedAll = photos.length > 0 && photos.every((p) => p.status === 'done');
  const failedCount = photos.filter((p) => p.status === 'failed').length;
  const progressPct =
    progress && progress.total ? Math.round(((progress.done + progress.failed) / progress.total) * 100) : 0;
  const currentModels = providers.find((p) => p.id === providerId)?.models ?? [];

  return (
    <div className="flex min-h-screen bg-paper">
      {/* 侧边栏：小屏抽屉，桌面常驻（sticky + h-screen，滚动看照片时导航不消失） */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-ink/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-30 lg:sticky lg:top-0 lg:z-auto lg:h-screen ${
          sidebarOpen ? 'block' : 'hidden'
        }`}
      >
        <SessionSidebar
          currentId={sessionId}
          onSelect={(id) => {
            setSidebarOpen(false);
            void switchSession(id);
          }}
          onCreated={(id) => {
            setSidebarOpen(false);
            void switchSession(id);
          }}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 border-b border-line bg-paper">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 lg:px-8">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              title="会话列表"
              className="border border-line px-2 py-1 text-ink transition-colors duration-300 hover:bg-ink hover:text-paper"
            >
              ☰
            </button>
            <span className="text-lg font-semibold tracking-[-0.02em]">📷 Moments</span>
            <span className="mono hidden text-muted sm:inline">AI PHOTO CURATION</span>
            <div className="flex-1" />
            <select
              value={providerId}
              onChange={(e) => switchProvider(e.target.value)}
              className="field mono w-auto py-1.5 text-[11px]"
              aria-label="模型供应商"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="field mono hidden w-auto py-1.5 text-[11px] sm:block"
              aria-label="模型"
            >
              {currentModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <span className="mono hidden text-muted md:inline">{me}</span>
            <button onClick={logout} className="mono text-muted transition-colors hover:text-ink">
              退出
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-6xl space-y-10 px-4 py-8 lg:px-8">
          {error && (
            <div className="border-l-2 border-ink bg-paper-2 px-4 py-3 text-sm text-ink">{error}</div>
          )}
          {notice && !analyzing && (
            <div className="border-l-2 border-ink bg-paper-2 px-4 py-3 text-sm text-ink">{notice}</div>
          )}

          {/* 导入区 */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (sessionId) void uploadFiles(Array.from(e.dataTransfer.files));
            }}
            onClick={() => sessionId && fileRef.current?.click()}
            className={`border-2 border-dashed p-10 text-center transition-colors duration-300 ${
              sessionId ? 'cursor-pointer' : 'cursor-wait opacity-60'
            } ${dragOver ? 'border-ink bg-paper-2' : 'border-line-soft hover:border-ink'}`}
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.heic,.heif"
              className="hidden"
              onChange={(e) => void uploadFiles(Array.from(e.target.files ?? []))}
            />
            <p className="mono text-muted">{sessionId ? 'DROP / SELECT' : 'INITIALIZING'}</p>
            <p className="mt-2 text-[15px] text-ink">
              {!sessionId
                ? '正在初始化会话…'
                : uploading
                  ? uploadPct != null
                    ? `上传中… ${uploadPct}%`
                    : '上传处理中…'
                  : '拖拽照片到这里，或点击选择（单次 ≤ 30 张，支持 iPhone HEIC / JPG / PNG / WebP）'}
            </p>
            {uploading && uploadPct != null && (
              <div className="mx-auto mt-4 h-1 w-64 border border-line-soft">
                <div className="h-full bg-ink transition-all" style={{ width: `${uploadPct}%` }} />
              </div>
            )}
            <p className="mt-2 text-xs text-muted">
              拍摄时间、连拍信息只用于排序与聚类，GPS 等隐私数据不会保留
            </p>
          </div>

          {/* 操作区 */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void startAnalyze()}
              disabled={!photos.length || analyzing || busy}
              className="btn btn--solid"
            >
              <span>{analyzing ? '分析中…' : `开始 AI 分析（${photos.length} 张）`}</span>
            </button>
            {failedCount > 0 && !analyzing && (
              <button
                onClick={() => void startAnalyze({ retryFailed: true })}
                disabled={busy}
                className="btn"
                title="只重新分析未完成的照片，已完成的不会重复花费"
              >
                <span>↻ 重试失败项（{failedCount}）</span>
              </button>
            )}
            {analyzing && (
              <button onClick={() => void cancelAnalyze()} className="btn">
                <span>取消</span>
              </button>
            )}
            <label className="mono ml-2 text-muted">TOP N</label>
            <select
              value={n}
              onChange={(e) => setN(Number(e.target.value))}
              className="field mono w-auto py-1.5 text-[11px]"
              aria-label="推荐张数"
            >
              {[1, 3, 4, 6, 9].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <button
              onClick={() => void pick()}
              disabled={!analyzedAll || analyzing || busy}
              className="btn btn--solid"
            >
              <span>AI 挑图</span>
            </button>
            <button
              onClick={() => void suggestCrops()}
              disabled={!analyzedAll || analyzing || suggesting}
              title={
                result
                  ? `只为 AI 推荐的 ${result.selected.length} 张生成二次构图建议`
                  : '为已完成分析、还没有建议的照片生成二次构图建议'
              }
              className="btn"
            >
              <span>
                {suggesting
                  ? `生成构图建议中…（${cropProgress?.done ?? 0}/${cropProgress?.total ?? 0}）`
                  : result
                    ? `✂ 为推荐 ${result.selected.length} 张生成构图`
                    : '✂ 生成构图建议'}
              </span>
            </button>
            {suggesting && (
              <button onClick={() => void cancelCrops()} className="btn">
                <span>取消构图</span>
              </button>
            )}
            <button
              onClick={() => void exportZip()}
              disabled={exporting || analyzing || (!result && !photos.some((p) => p.status === 'done'))}
              title={result ? '导出 AI 推荐的照片（zip）' : '导出全部已完成分析的照片（zip）'}
              className="btn"
            >
              <span>
                {exporting ? '打包中…' : result ? `⬇ 导出推荐 ${result.selected.length} 张` : '⬇ 导出 zip'}
              </span>
            </button>
            {analyzing && progress && (
              <div className="min-w-48 flex-1">
                <div className="h-1 border border-line-soft">
                  <div className="h-full bg-ink transition-all" style={{ width: `${progressPct}%` }} />
                </div>
                <p className="mono mt-1.5 text-muted">
                  {progress.done + progress.failed}/{progress.total}
                  {progress.failed ? ` · FAILED ${progress.failed}` : ''}
                </p>
              </div>
            )}
            {usage && usage.calls > 0 && (
              <span
                className="mono ml-auto text-muted"
                title={`模型调用 ${usage.calls} 次${usage.costEstimate != null ? `，预估费用 ¥${usage.costEstimate.toFixed(2)}` : ''}`}
              >
                🪙 {fmtTokens(usage.input)}↓ {fmtTokens(usage.output)}↑
                {usage.costEstimate != null ? ` · ≈¥${usage.costEstimate.toFixed(2)}` : ''}
              </span>
            )}
          </div>

          {/* 照片网格：无缝边框拼出的表格感 */}
          {photos.length === 0 ? (
            <p className="mono py-16 text-center text-muted">NO PHOTOS · 先导入一批吧</p>
          ) : (
            <div className="grid grid-cols-2 border-l border-t border-line sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {photos.map((p) => (
                <div
                  key={p.id}
                  className="group relative border-r border-b border-line bg-paper transition-colors duration-300 hover:bg-paper-2"
                >
                  <div className="aspect-square">
                    <PhotoThumb photoId={p.id} />
                  </div>
                  <button
                    onClick={() => setCropId(p.id)}
                    title="二次构图"
                    className="absolute top-1 left-1 flex h-6 w-6 items-center justify-center border border-line bg-paper text-xs text-ink transition-colors duration-300 hover:bg-ink hover:text-paper"
                  >
                    ✂
                  </button>
                  <button
                    onClick={() => void removePhoto(p.id)}
                    title="删除"
                    className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center border border-line bg-paper text-xs text-ink transition-colors duration-300 hover:bg-ink hover:text-paper"
                  >
                    ×
                  </button>
                  {p.crop ? (
                    <span
                      title={p.crop.source === 'ai' ? '已应用 LLM 的二次构图建议' : '手动调整的二次构图'}
                      className="mono absolute bottom-1 left-1 bg-ink px-1.5 py-0.5 text-[9px] text-paper"
                    >
                      ✂ {p.crop.source === 'ai' ? 'AI 构图' : '手动构图'}
                      {p.crop.ratio !== 'original' ? ` · ${p.crop.ratio}` : ''}
                    </span>
                  ) : (
                    p.cropSuggestion && (
                      <span
                        title={`LLM 建议：${p.cropSuggestion.reasoning}`}
                        className="mono absolute bottom-1 left-1 border border-ink bg-paper px-1.5 py-0.5 text-[9px] font-medium text-ink"
                      >
                        AI 建议待应用
                      </span>
                    )
                  )}
                  <div className="px-2.5 py-2">
                    <p className="truncate text-xs text-ink-soft" title={p.filename}>
                      {p.filename}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className={`mono px-1.5 py-0.5 text-[9px] ${statusMeta[p.status].cls}`}>
                        {statusMeta[p.status].label}
                      </span>
                      {p.analysis && (
                        <span className="mono border border-ink px-1.5 py-0.5 text-[9px] text-ink">
                          {p.analysis.score} 分
                        </span>
                      )}
                      {p.analysis?.issues.map((i) => (
                        <span
                          key={i}
                          className="mono border border-line-soft bg-paper-2 px-1.5 py-0.5 text-[9px] text-ink-soft"
                        >
                          {i}
                        </span>
                      ))}
                    </div>
                    {p.status === 'failed' && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <p className="line-clamp-2 flex-1 text-[11px] text-ink" title={p.error ?? ''}>
                          {p.error ?? '分析失败'}
                        </p>
                        <button
                          onClick={() => void retryPhoto(p.id)}
                          disabled={retryingId === p.id}
                          title="只重试这一张"
                          className="mono shrink-0 border border-ink px-1.5 py-0.5 text-[9px] text-ink transition-colors duration-300 hover:bg-ink hover:text-paper disabled:opacity-40"
                        >
                          {retryingId === p.id ? '重试中…' : '重试'}
                        </button>
                      </div>
                    )}
                    {p.analysis && (
                      <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted">
                        {p.analysis.reason}
                      </p>
                    )}
                    {p.analysis && (
                      <div className="mt-1.5 flex justify-end">
                        <FeedbackButtons
                          photoId={p.id}
                          value={p.analysis.feedback ?? 0}
                          onChanged={(v) => setFeedback(p.id, v)}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* AI 推荐 */}
          {result && (
            <section>
              <div className="sec-head">
                <span className="mono text-muted">01</span>
                <h2 className="sec-head__title">🏆 AI 推荐 {result.selected.length} 张</h2>
                <span className="mono ml-auto text-muted">TOP SELECTION</span>
              </div>
              <div className="grid grid-cols-2 border-l border-t border-line sm:grid-cols-3 md:grid-cols-5">
                {result.selected.map((s) => {
                  const p = photos.find((x) => x.id === s.photoId);
                  return (
                    <div
                      key={s.photoId}
                      className="relative border-r border-b border-line bg-paper transition-colors duration-300 hover:bg-paper-2"
                    >
                      <div className="relative aspect-square">
                        <PhotoThumb photoId={s.photoId} />
                        <span className="mono absolute top-1 left-1 flex h-6 w-6 items-center justify-center bg-ink text-xs font-medium text-paper">
                          {s.order}
                        </span>
                        <button
                          onClick={() => p && setCropId(p.id)}
                          className="mono absolute right-1 bottom-1 border border-line bg-paper px-1.5 py-0.5 text-[9px] text-ink transition-colors duration-300 hover:bg-ink hover:text-paper"
                        >
                          ✂ 构图
                        </button>
                      </div>
                      <p className="line-clamp-3 p-2.5 text-[11px] leading-relaxed text-ink-soft">
                        {s.reason}
                      </p>
                    </div>
                  );
                })}
              </div>
              <div className="mt-8">
                <div className="sec-head">
                  <span className="mono text-muted">02</span>
                  <h3 className="sec-head__title text-base">落选照片（{result.rejected.length}）</h3>
                  <span className="mono ml-auto text-muted">REJECTED</span>
                </div>
                <ul className="space-y-1.5">
                  {result.rejected.map((r) => (
                    <li key={r.photoId} className="flex items-center gap-2 text-xs text-ink-soft">
                      <span className={`mono px-1.5 py-0.5 text-[9px] ${rejectCls[r.category] ?? rejectCls['内容平淡']}`}>
                        {r.category}
                      </span>
                      <span className="max-w-48 truncate">{r.filename}</span>
                      <span className="text-muted">{r.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {photos.some((p) => p.status === 'done') && sessionId && (
            <CaptionPanel
              sessionId={sessionId}
              photoIds={
                result?.selected.map((s) => s.photoId) ?? photos.filter((p) => p.status === 'done').map((p) => p.id)
              }
              onChanged={() => sessionId && void fetchUsage(sessionId)}
            />
          )}

          {photos.some((p) => p.status === 'done') && (
            <LayoutPreview
              photos={photos}
              selectedIds={result ? result.selected.map((s) => s.photoId) : null}
              exporting={exporting}
              onExport={(ids) => void exportZip(ids)}
              onExportGrid={(ids) => void exportGrid(ids)}
            />
          )}

          <div className="hatch" aria-hidden />

          {cropId && (
            <CropModal
              photo={photos.find((p) => p.id === cropId)!}
              onClose={(refreshed) => {
                setCropId(null);
                if (refreshed && sessionId) void loadSession(sessionId);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
