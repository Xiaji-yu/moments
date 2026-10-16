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
  return s.title?.trim() || `${new Date(s.created_at ?? Date.now()).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 的会话`;
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
    <aside className="flex h-full w-72 flex-col border-r border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
        <h2 className="font-semibold">会话</h2>
        <div className="flex-1" />
        <button onClick={onClose} className="text-gray-400 transition hover:text-gray-700 lg:hidden" title="收起">
          ✕
        </button>
      </div>

      <div className="px-3 py-2">
        <button
          onClick={() => void create()}
          className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          ＋ 新建会话
        </button>
      </div>

      {error && <p className="px-4 pb-2 text-xs text-red-500">{error}</p>}
      {loading && <p className="px-4 pb-2 text-xs text-gray-400">加载中…</p>}

      <ul className="flex-1 space-y-1 overflow-auto px-2 pb-3">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={`group rounded-lg px-2 py-2 text-sm transition ${
              s.id === currentId ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-gray-50'
            }`}
          >
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
                  className="min-w-0 flex-1 rounded border border-gray-300 px-1.5 py-1 text-xs outline-none focus:border-blue-500"
                />
                <button onClick={() => void rename(s.id)} className="text-xs text-blue-600 hover:text-blue-700">
                  保存
                </button>
              </div>
            ) : (
              <button onClick={() => onSelect(s.id)} className="block w-full text-left" title="切换到该会话">
                <span className="block truncate font-medium text-gray-700">{labelOf(s)}</span>
                <span className="mt-0.5 block text-[11px] text-gray-400">
                  {s.photoCount ?? 0} 张 · {s.provider}
                  {s.model ? ` · ${s.model}` : ''}
                </span>
              </button>
            )}

            {editingId !== s.id && (
              <div className="mt-1 flex gap-2 opacity-0 transition group-hover:opacity-100">
                <button
                  onClick={() => {
                    setEditingId(s.id);
                    setDraftTitle(s.title ?? '');
                  }}
                  className="text-[11px] text-gray-400 hover:text-blue-600"
                >
                  重命名
                </button>
                <button onClick={() => void remove(s.id)} className="text-[11px] text-gray-400 hover:text-red-500">
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
