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
    <section>
      <div className="sec-head">
        <span className="mono text-muted">03</span>
        <h2 className="sec-head__title">📝 朋友圈文案</h2>
        <span className="mono ml-auto text-muted">CAPTION</span>
      </div>

      <div className="panel p-5">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value as CaptionStyle)}
            className="field mono h-9 w-auto shrink-0 py-1.5 text-[11px]"
            aria-label="文案风格"
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
            className="field h-9 w-full min-w-0 sm:w-52"
          />
          <div className="flex-1" />
          <button onClick={() => void generate()} disabled={busy} className="btn btn--solid btn--sm h-9 shrink-0">
            <span>{busy ? '生成中…' : items ? '重新生成' : '生成文案'}</span>
          </button>
        </div>

        {error && <p className="mt-3 border-l-2 border-ink pl-2 text-xs text-ink">{error}</p>}

        {items && (
          <div className="mt-5 space-y-3">
            {items.map((item, i) => (
              <div key={i} className="border border-line-soft">
                <div className="mono flex items-center gap-2 border-b border-line-soft bg-paper-2 px-3 py-1.5 text-[9px] text-muted">
                  <span className="border border-ink px-1.5 py-0.5 text-ink">{item.style}</span>
                  <div className="flex-1" />
                  <button
                    onClick={() => void copy(item.text, i)}
                    className="text-muted transition-colors hover:text-ink"
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
                  className="w-full resize-none border-0 bg-paper p-3 text-sm leading-relaxed text-ink outline-none"
                />
              </div>
            ))}
            <div className="flex justify-end">
              <button
                onClick={() => void save()}
                disabled={saving || !dirty}
                className="btn btn--sm"
              >
                <span>{saving ? '保存中…' : '保存文案（导出时打包 caption.txt）'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
