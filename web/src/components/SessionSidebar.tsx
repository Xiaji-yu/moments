import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SessionInfo } from '../types';

interface Props {
  currentId: string;
  /** 切换到某个会话；传空字符串表示「当前会话已被删除，请新建」 */
  onSelect: (id: string) => void;
  /** 新建会话成功后回调 */
  onCreated: (id: string) => void;
  onClose: () => void;
}

function labelOf(s: SessionInfo): string {
  return (
    s.title?.trim() ||
    `${new Date(s.created_at ?? Date.now()).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 的会话`
  );
}

/** 会话管理侧栏：列表 / 切换 / 新建 / 重命名 / 删除 */
export function SessionSidebar({ currentId, onSelect, onCreated, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ sessions: SessionInfo[] }>('/sessions');
      setSessions(r.sessions);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    try {
      const s = await api<SessionInfo>('/sessions', { method: 'POST', body: '{}' });
      await load();
      onCreated(s.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rename(id: string) {
    try {
      await api(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title: draftTitle }) });
      setEditingId(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('删除会话将同时删除其中所有照片，不可恢复，确定吗？')) return;
    try {
      await api(`/sessions/${id}`, { method: 'DELETE' });
      const deletingCurrent = id === currentId;
      await load();
      if (deletingCurrent) onSelect(''); // 由外层负责新建并切换
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <aside className="flex h-full w-72 flex-col border-r border-line bg-paper">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="mono text-muted">SESSIONS</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="mono text-muted transition-colors hover:text-ink lg:hidden"
          title="收起"
        >
          ✕
        </button>
      </div>

      <div className="px-3 py-3">
        <button onClick={() => void create()} className="btn btn--solid w-full">
          <span>＋ 新建会话</span>
        </button>
      </div>

      {error && <p className="px-4 pb-2 text-xs text-ink">{error}</p>}
      {loading && <p className="mono px-4 pb-2 text-muted">LOADING…</p>}

      <ul className="flex-1 space-y-0 overflow-auto border-t border-line-soft px-2 pb-3">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={`group relative border-b border-line-soft px-2 py-2.5 transition-colors duration-300 ${
              s.id === currentId ? 'bg-paper-2' : 'hover:bg-paper-2'
            }`}
          >
            {/* 当前会话：左侧墨条 */}
            {s.id === currentId && <span className="absolute inset-y-0 left-0 w-[2px] bg-ink" aria-hidden />}
            {editingId === s.id ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void rename(s.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  maxLength={40}
                  placeholder="给会话起个名字"
                  className="field min-w-0 flex-1 px-1.5 py-1 text-xs"
                />
                <button
                  onClick={() => void rename(s.id)}
                  className="mono text-ink transition-colors hover:text-muted"
                >
                  保存
                </button>
              </div>
            ) : (
              <button onClick={() => onSelect(s.id)} className="block w-full text-left" title="切换到该会话">
                <span
                  className={`block truncate text-[13px] font-medium ${
                    s.id === currentId ? 'text-ink' : 'text-ink-soft'
                  }`}
                >
                  {labelOf(s)}
                </span>
                <span className="mono mt-1 block text-[9px] text-muted">
                  {s.photoCount ?? 0} 张 · {s.provider}
                  {s.model ? ` · ${s.model}` : ''}
                </span>
                {s.id === currentId && (
                  <span className="mono mt-1 inline-block border border-ink px-1.5 py-0.5 text-[8px] text-ink">
                    CURRENT
                  </span>
                )}
              </button>
            )}

            {editingId !== s.id && (
              <div className="mono mt-1.5 flex gap-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                <button
                  onClick={() => {
                    setEditingId(s.id);
                    setDraftTitle(s.title ?? '');
                  }}
                  className="text-[9px] text-muted transition-colors hover:text-ink"
                >
                  重命名
                </button>
                <button
                  onClick={() => void remove(s.id)}
                  className="text-[9px] text-muted transition-colors hover:text-ink"
                >
                  删除
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
