import { useState } from 'react';
import { api } from '../api';

interface Props {
  photoId: string;
  /** 当前反馈值：1 赞 / -1 踩 / 0 无 */
  value: number;
  onChanged?: (v: number) => void;
}

/**
 * 对 AI 挑图/评分结果的反馈（👍/👎）。
 * 再次点击同一按钮 = 取消反馈；失败静默忽略，不影响主流程。
 */
export function FeedbackButtons({ photoId, value, onChanged }: Props) {
  const [busy, setBusy] = useState(false);

  async function set(next: number) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/photos/${photoId}/feedback`, {
        method: 'PUT',
        body: JSON.stringify({ feedback: next }),
      });
      onChanged?.(next);
    } catch {
      // 反馈失败不影响主流程
    } finally {
      setBusy(false);
    }
  }

  const btn = (v: number, label: string, title: string) => (
    <button
      key={v}
      onClick={(e) => {
        e.stopPropagation();
        void set(value === v ? 0 : v);
      }}
      disabled={busy}
      title={title}
      className={`rounded px-1 py-0.5 text-[11px] transition disabled:opacity-40 ${
        value === v ? 'bg-blue-100 text-blue-700' : 'text-gray-300 hover:bg-gray-100 hover:text-gray-500'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-0.5">
      {btn(1, '👍', '挑得好，以后多来点')}
      {btn(-1, '👎', '挑得不好')}
    </div>
  );
}
