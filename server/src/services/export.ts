import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { boxToPixelExtract } from './cropBox.js';
import { photoDir } from './storage.js';

export interface ExportRow {
  id: string;
  filename: string;
  width: number;
  height: number;
  /** crops 表字段（LEFT JOIN 而来，未裁剪时为 null） */
  c_x?: number | null;
  c_y?: number | null;
  c_w?: number | null;
  c_h?: number | null;
}

/** 读取照片的导出用 JPEG：已应用裁剪的按原图坐标裁剪，否则原图（AC-F6-4） */
export async function loadExportImage(
  userId: number,
  sessionId: string,
  row: ExportRow,
): Promise<Buffer> {
  const file = path.join(photoDir(userId, sessionId, row.id), 'original.jpg');
  const { c_x: bx, c_y: by, c_w: bw, c_h: bh } = row;
  if (bx != null && by != null && bw != null && bh != null && row.width > 0 && row.height > 0) {
    const extract = boxToPixelExtract({ x: bx, y: by, w: bw, h: bh }, row.width, row.height);
    return sharp(file).extract(extract).jpeg({ quality: 92 }).toBuffer();
  }
  return fs.readFile(file);
}

/** 文件名安全化（zip 条目名不能带路径分隔符与 Windows 保留字符） */
export function safeFilename(name: string): string {
  return String(name ?? 'photo').replace(/[\\/:*?"<>|]/g, '_');
}
