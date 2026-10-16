import { useEffect, useRef, useState } from 'react';
import { api, authBlob } from '../api';
import { boxPixelText, fitBoxToRatio, normRatio } from '../crop';
import { RATIO_LABEL, RATIO_LIST, type Box, type CropSuggestion, type Photo, type Ratio } from '../types';

interface Props {
  photo: Photo;
  onClose: (refreshed: boolean) => void;
}

type DragState =
  | { mode: 'move'; startX: number; startY: number; startBox: Box }
  | { mode: 'resize'; handle: 'nw' | 'ne' | 'sw' | 'se'; anchor: { x: number; y: number } }
  | null;

const FULL_BOX: Box = { x: 0, y: 0, w: 1, h: 1 };

export function CropModal({ photo, onClose }: Props) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ nw: number; nh: number } | null>(null);
  const [suggestion, setSuggestion] = useState<CropSuggestion | null>(photo.cropSuggestion);
  const [ratio, setRatio] = useState<Ratio>(photo.crop?.ratio ?? photo.cropSuggestion?.ratio ?? 'original');
  const [box, setBox] = useState<Box>(photo.crop?.box ?? photo.cropSuggestion?.box ?? FULL_BOX);
  const [source, setSource] = useState<'ai' | 'manual' | 'original'>(
    photo.crop ? photo.crop.source : photo.cropSuggestion ? 'ai' : 'manual',
  );
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>(null);

  // 加载原图（按原图坐标预览与导出，AC-F6-4）
  useEffect(() => {
    let dead = false;
    let objectUrl: string | null = null;
    authBlob(`/photos/${photo.id}/image`)
      .then((blob) => {
        if (dead) return;
        objectUrl = URL.createObjectURL(blob);
        setImgUrl(objectUrl);
      })
      .catch(() => setError('原图加载失败'));
    return () => {
      dead = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photo.id]);

  const r = normRatio(ratio, imgSize?.nw ?? 4, imgSize?.nh ?? 3);

  function toNormalized(e: React.PointerEvent): { x: number; y: number } {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!imgSize) return;
    const target = e.target as HTMLElement;
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle');
    const p = toNormalized(e);
    if (handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se') {
      const anchor = {
        x: handle === 'nw' || handle === 'sw' ? box.x + box.w : box.x,
        y: handle === 'nw' || handle === 'ne' ? box.y + box.h : box.y,
      };
      dragRef.current = { mode: 'resize', handle, anchor };
    } else if (target.closest('[data-role="box"]')) {
      dragRef.current = { mode: 'move', startX: p.x, startY: p.y, startBox: box };
    } else {
      return;
    }
    e.preventDefault();
    overlayRef.current?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || !imgSize) return;
    const p = toNormalized(e);

    if (drag.mode === 'move') {
      const dx = p.x - drag.startX;
      const dy = p.y - drag.startY;
      setBox({
        ...drag.startBox,
        x: Math.min(1 - drag.startBox.w, Math.max(0, drag.startBox.x + dx)),
        y: Math.min(1 - drag.startBox.h, Math.max(0, drag.startBox.y + dy)),
      });
    } else {
      // 角部缩放：固定对角锚点，保持比例（AC-F6-3）
      const { anchor } = drag;
      const dx = p.x - anchor.x;
      const dy = p.y - anchor.y;
      let w = Math.max(Math.abs(dx), Math.abs(dy) * r, 0.08);
      const maxW = dx >= 0 ? 1 - anchor.x : anchor.x;
      const maxH = dy >= 0 ? 1 - anchor.y : anchor.y;
      w = Math.min(w, maxW, maxH * r);
      const h = w / r;
      setBox({
        x: dx >= 0 ? anchor.x : anchor.x - w,
        y: dy >= 0 ? anchor.y : anchor.y - h,
        w,
        h,
      });
    }
    setSource('manual');
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  function switchRatio(next: Ratio) {
    if (!imgSize) return;
    const nextBox = fitBoxToRatio(box, normRatio(next, imgSize.nw, imgSize.nh));
    const sameAsSuggestion = boxSame(nextBox, suggestion && suggestion.ratio === next ? suggestion.box : null);
    setRatio(next);
    setBox(nextBox);
    setSource(sameAsSuggestion ? 'ai' : 'manual');
  }

  function boxSame(a: Box, b: Box | null | undefined): boolean {
    if (!b) return false;
    return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6;
  }

  function applySuggestion() {
    if (suggestion) {
      setRatio(suggestion.ratio);
      setBox(suggestion.box);
      setSource('ai');
    }
  }

  async function generateSuggestion() {
    setSuggesting(true);
    setError('');
    try {
      await api(`/photos/${photo.id}/crop-suggest`, { method: 'POST', body: '{}' });
      const res = await api<{ suggestion: CropSuggestion | null }>(`/photos/${photo.id}/crop`);
      if (res.suggestion) {
        setSuggestion(res.suggestion);
        setRatio(res.suggestion.ratio);
        setBox(res.suggestion.box);
        setSource('ai');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (source === 'original') {
        await api(`/photos/${photo.id}/crop`, { method: 'PUT', body: JSON.stringify({ source: 'original' }) });
      } else {
        await api(`/photos/${photo.id}/crop`, {
          method: 'PUT',
          body: JSON.stringify({ ratio, box, source }),
        });
      }
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  const dirty =
    source === 'original' ||
    !!photo.crop === false ||
    !photo.crop ||
    ratio !== photo.crop.ratio ||
    !boxSame(box, photo.crop.box);

  const btn =
    'rounded-lg px-3 py-1.5 text-sm transition disabled:opacity-40';
  const btnGhost = `${btn} border border-gray-300 text-gray-600 hover:bg-gray-50`;
  const btnPrimary = `${btn} bg-blue-600 text-white hover:bg-blue-700`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => onClose(false)}>
      <div
        className="max-h-[94vh] w-full max-w-4xl space-y-3 overflow-auto rounded-xl bg-white p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-semibold">✂ 二次构图 · {photo.filename}</h2>
            <p className="text-xs text-gray-500">
              {suggestion ? `AI 建议：${suggestion.reasoning}` : '暂无 AI 建议，可手动裁剪或点击「生成 AI 建议」'}
            </p>
          </div>
          <button onClick={() => onClose(false)} className="text-gray-400 hover:text-gray-700">
            ✕
          </button>
        </div>

        <div className="flex justify-center">
          <div
            ref={overlayRef}
            className="relative touch-none select-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {imgUrl && (
              <img
                src={imgUrl}
                alt=""
                draggable={false}
                className="mx-auto block max-h-[58vh] max-w-full"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setImgSize({ nw: el.naturalWidth, nh: el.naturalHeight });
                }}
              />
            )}
            {imgSize && (
              <>
                {/* 框外遮罩 */}
                <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/50" style={{ height: `${box.y * 100}%` }} />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/50" style={{ height: `${(1 - box.y - box.h) * 100}%` }} />
                <div className="pointer-events-none absolute bg-black/50" style={{ left: 0, top: `${box.y * 100}%`, width: `${box.x * 100}%`, height: `${box.h * 100}%` }} />
                <div className="pointer-events-none absolute bg-black/50" style={{ left: `${(box.x + box.w) * 100}%`, top: `${box.y * 100}%`, right: 0, height: `${box.h * 100}%` }} />
                {/* 裁剪框 + 三分线 */}
                <div
                  data-role="box"
                  className="absolute cursor-move border-2 border-blue-400 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
                  style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
                >
                  <div className="pointer-events-none absolute left-1/3 top-0 h-full w-px bg-white/40" />
                  <div className="pointer-events-none absolute left-2/3 top-0 h-full w-px bg-white/40" />
                  <div className="pointer-events-none absolute top-1/3 left-0 w-full h-px bg-white/40" />
                  <div className="pointer-events-none absolute top-2/3 left-0 w-full h-px bg-white/40" />
                </div>
                {/* 角部缩放 handle */}
                {(
                  [
                    ['nw', 'left', 'top', 'nwse-resize'],
                    ['ne', 'right', 'top', 'nesw-resize'],
                    ['sw', 'left', 'bottom', 'nesw-resize'],
                    ['se', 'right', 'bottom', 'nwse-resize'],
                  ] as const
                ).map(([h, l, t, cursor]) => (
                  <div
                    key={h}
                    data-handle={h}
                    className={`absolute h-4 w-4 rounded-full border-2 border-blue-500 bg-white ${cursor === 'nwse-resize' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
                    style={{
                      [l]: `${(l === 'left' ? box.x : box.x + box.w) * 100}%`,
                      [t]: `${(t === 'top' ? box.y : box.y + box.h) * 100}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-400">比例</span>
          {RATIO_LIST.map((rt) => (
            <button
              key={rt}
              onClick={() => switchRatio(rt)}
              className={`${btn} ${ratio === rt ? 'bg-blue-50 font-medium text-blue-700 ring-1 ring-blue-300' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            >
              {RATIO_LABEL[rt]}
            </button>
          ))}
          <div className="flex-1" />
          {imgSize && <span className="text-xs text-gray-500">导出 {boxPixelText(box, imgSize.nw, imgSize.nh)}</span>}
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          {suggestion ? (
            <button className={btnGhost} onClick={applySuggestion}>
              应用 AI 建议
            </button>
          ) : (
            <button className={btnGhost} onClick={() => void generateSuggestion()} disabled={suggesting}>
              {suggesting ? '生成中…' : '生成 AI 建议'}
            </button>
          )}
          <button
            className={btnGhost}
            onClick={() => {
              if (suggestion) applySuggestion();
              else {
                setRatio('original');
                setBox(FULL_BOX);
                setSource('manual');
              }
            }}
            disabled={!suggestion}
            title={suggestion ? '回到 AI 建议的框' : '暂无建议'}
          >
            重置
          </button>
          <button
            className={btnGhost}
            onClick={() => {
              setRatio('original');
              setBox(FULL_BOX);
              setSource('original');
            }}
          >
            还原原始
          </button>
          <div className="flex-1" />
          <button className={btnGhost} onClick={() => onClose(false)}>
            取消
          </button>
          <button className={btnPrimary} onClick={() => void save()} disabled={saving || !imgSize || !dirty}>
            {saving ? '保存中…' : '保存并应用'}
          </button>
        </div>
      </div>
    </div>
  );
}
