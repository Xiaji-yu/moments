import crypto from 'node:crypto';
import sharp from 'sharp';
import exifReader from 'exif-reader';

export interface ProcessedImage {
  /** 已按 EXIF 方向纠正、剥离元数据的 JPEG（质量 92） */
  original: Buffer;
  /** 缩略图（长边 480） */
  thumb: Buffer;
  /** 发给模型用的压缩图（长边 1024，≤400KB 量级） */
  send: Buffer;
  width: number;
  height: number;
  /** sha256，用于完全重复去重 */
  hash: string;
  /** 感知哈希（64bit hex），用于相似照聚类 */
  phash: string;
  /** EXIF 拍摄时间；无 EXIF 时回退为文件时间 */
  takenAt: string;
  hasExif: boolean;
}

const HASH_SIZE = 32;
const KEEP = 8;

let dctM: number[][] | null = null;
function dctMatrix(n: number): number[][] {
  if (dctM) return dctM;
  const m: number[][] = [];
  for (let k = 0; k < n; k++) {
    const row: number[] = [];
    for (let i = 0; i < n; i++) {
      row.push(Math.cos((Math.PI * (2 * i + 1) * k) / (2 * n)) * (k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n)));
    }
    m.push(row);
  }
  dctM = m;
  return m;
}

/** DCT 感知哈希（pHash），返回 16 位 hex */
export async function pHashOf(jpeg: Buffer): Promise<string> {
  const { data } = await sharp(jpeg)
    .grayscale()
    .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const a: number[][] = [];
  for (let y = 0; y < HASH_SIZE; y++) {
    a.push(Array.from(data.slice(y * HASH_SIZE, (y + 1) * HASH_SIZE), (v) => v));
  }
  const m = dctMatrix(HASH_SIZE);
  const tmp: number[][] = Array.from({ length: HASH_SIZE }, () => new Array<number>(HASH_SIZE).fill(0));
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      let s = 0;
      for (let i = 0; i < HASH_SIZE; i++) s += m[x][i] * a[y][i];
      tmp[y][x] = s;
    }
  }
  const vals: number[] = [];
  for (let k = 0; k < KEEP; k++) {
    for (let u = 0; u < KEEP; u++) {
      if (k === 0 && u === 0) continue;
      let s = 0;
      for (let j = 0; j < HASH_SIZE; j++) s += m[k][j] * tmp[j][u];
      vals.push(s);
    }
  }
  const sorted = [...vals].sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1];
  let bits = 0n;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] > median) bits |= 1n << BigInt(i);
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingHex(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let c = 0;
  while (x) {
    if (x & 1n) c++;
    x >>= 1n;
  }
  return c;
}

function toIso(d: Date | undefined | null): string | null {
  return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : null;
}

export async function processImage(buf: Buffer, fallbackTimeMs: number): Promise<ProcessedImage> {
  const base = sharp(buf).rotate(); // 自动按 EXIF 方向纠正

  // 只解析拍摄时间，GPS 等其余元数据一律不读取不保留（隐私最小化）
  let takenAt: string | null = null;
  try {
    const meta = await base.metadata();
    if (meta.exif) {
      const ex = exifReader(meta.exif) as {
        Photo?: { DateTimeOriginal?: Date; DateTimeDigitized?: Date };
        Image?: { DateTime?: Date };
      };
      takenAt = toIso(ex?.Photo?.DateTimeOriginal) ?? toIso(ex?.Photo?.DateTimeDigitized) ?? toIso(ex?.Image?.DateTime);
    }
  } catch {
    // EXIF 解析失败不影响导入
  }
  const hasExif = takenAt !== null;

  // rotate 之后再输出，sharp 默认剥离全部元数据
  const original = await base.jpeg({ quality: 92 }).toBuffer();
  const meta2 = await sharp(original).metadata();
  const thumb = await sharp(original)
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  const send = await sharp(original)
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  return {
    original,
    thumb,
    send,
    width: meta2.width ?? 0,
    height: meta2.height ?? 0,
    hash: crypto.createHash('sha256').update(original).digest('hex'),
    phash: await pHashOf(original),
    takenAt: takenAt ?? new Date(fallbackTimeMs).toISOString(),
    hasExif,
  };
}
