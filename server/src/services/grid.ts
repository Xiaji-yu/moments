import sharp from 'sharp';

export interface GridOptions {
  /** 列数（1/2/3…）；行数按照片数自动推算 */
  cols: number;
  /** 单格边长（px） */
  cell?: number;
  /** 格子间距（px） */
  gap?: number;
  /** 背景色（留白处） */
  background?: string;
}

/**
 * 把 N 张图拼成 cols 列网格图（每格等比缩放居中、留白补背景色）。
 * 用于「导出九宫格大图」——朋友圈单图发布的最终产物。
 */
export async function composeGrid(images: Buffer[], opts: GridOptions): Promise<Buffer> {
  const cols = Math.max(1, Math.floor(opts.cols));
  const cell = Math.max(64, Math.floor(opts.cell ?? 640));
  const gap = Math.max(0, Math.floor(opts.gap ?? 8));
  const background = opts.background ?? '#ffffff';
  const rows = Math.max(1, Math.ceil(images.length / cols));
  const width = cols * cell + (cols - 1) * gap;
  const height = rows * cell + (rows - 1) * gap;

  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < images.length; i++) {
    const fitted = await sharp(images[i])
      .resize(cell, cell, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    // 先垫成正方形格，再整体 composite，保证所有格严格对齐
    const padded = await sharp({ create: { width: cell, height: cell, channels: 3, background } })
      .composite([{ input: fitted, gravity: 'center' }])
      .jpeg({ quality: 90 })
      .toBuffer();
    composites.push({
      input: padded,
      left: (i % cols) * (cell + gap),
      top: Math.floor(i / cols) * (cell + gap),
    });
  }

  return sharp({ create: { width, height, channels: 3, background } })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
}
