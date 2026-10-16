import { useEffect, useState } from 'react';
import { PhotoThumb } from './PhotoThumb';
import type { Photo } from '../types';

interface Props {
  photos: Photo[];
  /** 有 AI 推荐时用推荐顺序，否则用全部已完成照片 */
  selectedIds: string[] | null;
  exporting: boolean;
  onExport: (orderedIds: string[]) => void;
  /** 按当前排版导出单张九宫格拼图 */
  onExportGrid?: (orderedIds: string[]) => void;
}

const TEMPLATES = [1, 3, 4, 9] as const;

/** 模板张数 → 拼图列数（1/3/4/9 → 1/3/2/3） */
const TEMPLATE_COLS: Record<number, number> = { 1: 1, 3: 3, 4: 2, 9: 3 };

/** 朋友圈排版预览：1/3/4/9 模板 + 拖拽/点选交换 + 按此顺序导出（AC-F8-1~4） */
export function LayoutPreview({ photos, selectedIds, exporting, onExport, onExportGrid }: Props) {
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
    <section>
      <div className="sec-head">
        <span className="mono text-muted">04</span>
        <h2 className="sec-head__title">🖼 排版预览</h2>
        <span className="mono ml-auto text-muted">LAYOUT · DRAG TO SWAP</span>
      </div>

      <div className="panel p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono text-muted">TEMPLATE</span>
          {TEMPLATES.map((t) => (
            <button
              key={t}
              onClick={() => setTemplate(t)}
              className={`mono border px-3 py-1.5 text-[11px] transition-colors duration-300 ${
                template === t
                  ? 'border-ink bg-ink text-paper'
                  : 'border-line-soft text-ink-soft hover:border-ink hover:text-ink'
              }`}
            >
              {t} 张
            </button>
          ))}
        </div>

        <div className="mx-auto mt-5 max-w-md border border-line bg-paper-2 p-3">
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
                className={`relative aspect-square overflow-hidden border ${
                  photoId ? 'cursor-pointer border-line' : 'border-dashed border-line-soft'
                } ${selIdx === idx ? 'ring-2 ring-ink' : dragIdx === idx ? 'opacity-50' : ''}`}
                title={photoId ? nameOf(photoId) : '待补充'}
              >
                {photoId ? (
                  <>
                    <PhotoThumb photoId={photoId} />
                    <span className="mono absolute left-1 top-1 flex h-5 w-5 items-center justify-center bg-ink text-[9px] font-medium text-paper">
                      {idx + 1}
                    </span>
                  </>
                ) : (
                  <div className="mono flex h-full w-full items-center justify-center text-[9px] text-muted">
                    待补充
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {filled < template && (
          <p className="mono mt-4 text-center text-[10px] text-ink">
            还有 {template - filled} 个空位：继续挑选照片或切换更小的模板
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line-soft pt-4">
          {onExportGrid && (
            <button
              onClick={() => onExportGrid(order.slice(0, template).filter((id): id is string => !!id))}
              disabled={exporting || filled === 0}
              title="把当前排版拼成一张大图（发朋友圈单图用）"
              className="btn btn--sm"
            >
              <span>{exporting ? '打包中…' : `🖼 导出拼图（${TEMPLATE_COLS[template]} 列）`}</span>
            </button>
          )}
          <button
            onClick={() => onExport(order.slice(0, template).filter((id): id is string => !!id))}
            disabled={exporting || filled === 0}
            className="btn btn--sm"
          >
            <span>{exporting ? '打包中…' : `⬇ 按此顺序导出 ${filled} 张`}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
