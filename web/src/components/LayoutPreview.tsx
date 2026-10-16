import { useEffect, useState } from 'react';
import { PhotoThumb } from './PhotoThumb';
import type { Photo } from '../types';

interface Props {
  photos: Photo[];
  /** 有 AI 推荐时用推荐顺序，否则用全部已完成照片 */
  selectedIds: string[] | null;
  exporting: boolean;
  onExport: (orderedIds: string[]) => void;
}

const TEMPLATES = [1, 3, 4, 9] as const;

/** 朋友圈排版预览：1/3/4/9 模板 + 拖拽/点选交换 + 按此顺序导出（AC-F8-1~4） */
export function LayoutPreview({ photos, selectedIds, exporting, onExport }: Props) {
  const [template, setTemplate] = useState<number>(9);
  const [order, setOrder] = useState<string[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [selIdx, setSelIdx] = useState<number | null>(null);

  const sourceIds: string[] =
    selectedIds ?? photos.filter((p) => p.status === 'done').map((p) => p.id);
  const sourceKey = sourceIds.join(',');

  useEffect(() => {
    setOrder(sourceIds);
    setSelIdx(null);
    setDragIdx(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  function swap(i: number, j: number) {
    if (i === j) return;
    setOrder((o) => {
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function cellClick(i: number) {
    if (selIdx === null) setSelIdx(i);
    else if (selIdx === i) setSelIdx(null);
    else {
      swap(selIdx, i);
      setSelIdx(null);
    }
  }

  const visible = Array.from({ length: template }, (_, i) => ({ idx: i, photoId: order[i] ?? null }));
  const filled = visible.filter((v) => v.photoId).length;
  const gridCols = template === 1 ? 'grid-cols-1' : template === 4 ? 'grid-cols-2' : 'grid-cols-3';
  const nameOf = (id: string | null) => photos.find((p) => p.id === id)?.filename ?? '';

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">🖼 排版预览</h2>
        <span className="text-xs text-gray-400">拖拽或点选两张交换位置</span>
        <div className="flex-1" />
        {TEMPLATES.map((t) => (
          <button
            key={t}
            onClick={() => setTemplate(t)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              template === t
                ? 'bg-blue-50 font-medium text-blue-700 ring-1 ring-blue-300'
                : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {t} 张
          </button>
        ))}
      </div>

      <div className="mx-auto max-w-md rounded-xl border border-gray-100 bg-gray-50 p-3">
        <div className={`grid gap-1.5 ${gridCols}`}>
          {visible.map(({ idx, photoId }) => (
            <div
              key={idx}
              draggable={!!photoId}
              onDragStart={() => setDragIdx(idx)}
              onDragOver={(e) => {
                if (dragIdx !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null && dragIdx !== idx) swap(dragIdx, idx);
                setDragIdx(null);
              }}
              onClick={() => photoId && cellClick(idx)}
              className={`relative aspect-square overflow-hidden ${photoId ? 'cursor-pointer' : ''} ${
                selIdx === idx ? 'ring-2 ring-blue-500' : dragIdx === idx ? 'opacity-50' : ''
              }`}
              title={photoId ? nameOf(photoId) : '待补充'}
            >
              {photoId ? (
                <>
                  <PhotoThumb photoId={photoId} />
                  <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[10px] font-medium text-white">
                    {idx + 1}
                  </span>
                </>
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded border-2 border-dashed border-gray-200 text-[10px] text-gray-300">
                  待补充
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {filled < template && (
        <p className="text-center text-xs text-orange-500">
          还有 {template - filled} 个空位：继续挑选照片或切换更小的模板
        </p>
      )}

      <div className="flex justify-end">
        <button
          onClick={() => onExport(order.slice(0, template).filter((id): id is string => !!id))}
          disabled={exporting || filled === 0}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
        >
          {exporting ? '打包中…' : `⬇ 按此顺序导出 ${filled} 张`}
        </button>
      </div>
    </section>
  );
}
