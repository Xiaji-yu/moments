import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CaptionItem, CaptionStyle } from '../types';

interface Props {
  sessionId: string;
  photoIds: string[];
  onChanged: () => void;
}

const STYLES: CaptionStyle[] = ['混合', '简洁', '文艺', '搞笑'];

/** 朋友圈文案生成/编辑/复制/保存（AC-F7-1~4） */
export function CaptionPanel({ sessionId, photoIds, onChanged }: Props) {
  const [style, setStyle] = useState<CaptionStyle>('混合');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<CaptionItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: CaptionItem[] | null }>(`/sessions/${sessionId}/caption`)
      .then((r) => setItems(r.items))
      .catch(() => {});
  }, [sessionId]);

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ items: CaptionItem[] }>(`/sessions/${sessionId}/caption`, {
        method: 'POST',
        body: JSON.stringify({ style, note: note || undefined, photoIds }),
      });
      setItems(r.items);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!items) return;
    setSaving(true);
    setError('');
    try {
      await api(`/sessions/${sessionId}/caption`, { method: 'PUT', body: JSON.stringify({ items }) });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function copy(text: string, i: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(i);
      window.setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      setError('复制失败，请手动选择文本复制');
    }
  }

  const dirty = !!items && items.length > 0;

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">📝 朋友圈文案</h2>
        <div className="flex-1" />
        <select
          value={style}
          onChange={(e) => setStyle(e.target.value as CaptionStyle)}
          className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500"
        >
          {STYLES.map((s) => (
            <option key={s} value={s}>
              {s === '混合' ? '混合风格' : `${s}风格`}
            </option>
          ))}
        </select>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="补充说明（可选，如：三亚蜜月）"
          className="w-52 rounded-lg border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
        />
        <button
          onClick={() => void generate()}
          disabled={busy}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? '生成中…' : items ? '重新生成' : '生成文案'}
        </button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {items && (
        <>
          <div className="space-y-2">
            {items.map((item, i) => (
              <div key={i} className="rounded-lg border border-gray-200 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] text-purple-600">{item.style}</span>
                  <div className="flex-1" />
                  <button
                    onClick={() => void copy(item.text, i)}
                    className="text-xs text-gray-400 transition hover:text-blue-600"
                  >
                    {copiedIdx === i ? '已复制 ✓' : '复制'}
                  </button>
                </div>
                <textarea
                  value={item.text}
                  onChange={(e) =>
                    setItems((prev) => prev!.map((p, j) => (j === i ? { ...p, text: e.target.value } : p)))
                  }
                  rows={Math.max(2, item.text.split('\n').length)}
                  className="w-full resize-none rounded-md border-0 bg-gray-50 p-2 text-sm text-gray-700 outline-none focus:bg-white focus:ring-1 focus:ring-blue-300"
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-40"
            >
              {saving ? '保存中…' : '保存文案（导出时打包 caption.txt）'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
