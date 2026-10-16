import type { FastifyInstance } from 'fastify';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { db } from '../src/db.js';

export type App = FastifyInstance & { inject: FastifyInstance['inject'] };

export async function makeApp(opts: { rateLimit?: boolean } = {}) {
  const { buildApp } = await import('../src/app.js');
  return buildApp({ logger: false, ...opts });
}

export interface FilePart {
  name: string;
  buf: Buffer;
  type?: string;
}

/** 生成纯色 JPEG（测试图片） */
export async function makeJpeg(
  w: number,
  h: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}

/* ---------------- 手工构造带 EXIF 的 JPEG ---------------- */

/** 最小 EXIF TIFF（little-endian）：IFD0{Orientation} + ExifIFD{DateTimeOriginal} */
export function buildExifTiff(orientation?: number, dateStr?: string): Uint8Array {
  const enc = new TextEncoder();
  const dateBytes = dateStr ? enc.encode(dateStr + '\0') : new Uint8Array(0);
  const hasDate = dateBytes.length > 0;
  const headerLen = 8;
  const ifd0Entries = orientation != null ? 2 : hasDate ? 1 : 0;
  const ifd0Len = 2 + ifd0Entries * 12 + 4;
  const ifd1Off = headerLen + ifd0Len;
  const ifd1Len = hasDate ? 2 + 12 + 4 : 0;
  const dataOff = ifd1Off + ifd1Len;
  const tiff = new Uint8Array(dataOff + dateBytes.length);
  const dv = new DataView(tiff.buffer);
  tiff.set(enc.encode('II'), 0);
  dv.setUint16(2, 0x2a, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, ifd0Entries, true);
  let p = 10;
  if (orientation != null) {
    dv.setUint16(p, 0x0112, true);
    dv.setUint16(p + 2, 3, true);
    dv.setUint32(p + 4, 1, true);
    dv.setUint16(p + 8, orientation, true);
    p += 12;
  }
  if (hasDate) {
    dv.setUint16(p, 0x8769, true);
    dv.setUint16(p + 2, 4, true);
    dv.setUint32(p + 4, 1, true);
    dv.setUint32(p + 8, ifd1Off, true);
    p += 12;
  }
  dv.setUint32(p, 0, true);
  if (hasDate) {
    dv.setUint16(ifd1Off, 1, true);
    dv.setUint16(ifd1Off + 2, 0x9003, true);
    dv.setUint16(ifd1Off + 4, 2, true);
    dv.setUint32(ifd1Off + 6, dateBytes.length, true);
    dv.setUint32(ifd1Off + 10, dataOff, true);
    dv.setUint32(ifd1Off + 14, 0, true);
    tiff.set(dateBytes, dataOff);
  }
  return tiff;
}

/** 生成带 EXIF（方向 / 拍摄时间）的 JPEG */
export async function jpegWithExif(
  w: number,
  h: number,
  color: { r: number; g: number; b: number },
  opts: { orientation?: number; dateStr?: string } = {},
): Promise<Buffer> {
  const base = await makeJpeg(w, h, color);
  const tiff = buildExifTiff(opts.orientation, opts.dateStr);
  if (tiff.length === 0) return base;
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(tiff)]);
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

/* ---------------- API 调用便捷封装 ---------------- */

export async function register(
  app: App,
  username = `u_${Math.random().toString(36).slice(2, 10)}`,
  password = 'passw0rd1',
): Promise<{ token: string; username: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  return res.json() as { token: string; username: string };
}

export async function createSession(app: App, token: string): Promise<{ id: string; provider: string; model: string | null }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {},
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.statusCode !== 200) throw new Error(`create session failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

export async function uploadPhotos(
  app: App,
  token: string,
  sessionId: string,
  files: FilePart[],
) {
  const form = new FormData();
  for (const f of files) {
    form.append('files', new Blob([new Uint8Array(f.buf)], { type: f.type ?? 'image/jpeg' }), f.name);
  }
  return app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/photos`,
    payload: form,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 上传一张并直接标记分析完成（不真正调用模型）。需要磁盘上存在 send.jpg 供后续 crop 等流程读取。 */
export async function uploadDonePhoto(
  app: App,
  token: string,
  sessionId: string,
  userId: number,
  file: FilePart,
): Promise<{ photoId: string }> {
  const up = await uploadPhotos(app, token, sessionId, [file]);
  if (up.statusCode !== 200) throw new Error(`upload failed: ${up.body}`);
  const row = db
    .prepare('SELECT id FROM photos WHERE session_id = ? AND filename = ?')
    .get(sessionId, file.name) as { id: string } | undefined;
  if (!row) throw new Error(`photo not found after upload: ${file.name}`);
  db.prepare(`UPDATE photos SET status = 'done' WHERE id = ?`).run(row.id);
  void userId;
  return { photoId: row.id };
}

/* ---------------- 数据库插桩 ---------------- */

export function insertPhotoRow(p: {
  id: string;
  sessionId: string;
  userId: number;
  filename?: string;
  phash?: string;
  takenAt?: string;
  hasExif?: boolean;
  status?: string;
  width?: number;
  height?: number;
}): void {
  db.prepare(
    `INSERT INTO photos (id, session_id, user_id, filename, hash, phash, width, height, taken_at, has_exif, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    p.sessionId,
    p.userId,
    p.filename ?? `${p.id}.jpg`,
    `hash_${p.id}`,
    p.phash ?? `ph_${p.id}`,
    p.width ?? 100,
    p.height ?? 100,
    p.takenAt ?? new Date().toISOString(),
    p.hasExif ? 1 : 0,
    p.status ?? 'done',
  );
}

export function insertAnalysisRow(photoId: string, a: { score: number; tags?: string[]; issues?: string[]; reason?: string }): void {
  db.prepare(
    'INSERT INTO analyses (photo_id, score, tags, issues, reason, model) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(photoId, a.score, JSON.stringify(a.tags ?? []), JSON.stringify(a.issues ?? []), a.reason ?? '不错', 'mock-vision');
}

/** 插入会话（跳过 API，供服务层测试使用） */
export function insertSessionRow(id: string, userId: number): void {
  db.prepare(`INSERT INTO sessions (id, user_id, provider, model) VALUES (?, ?, 'mock', 'mock-vision')`).run(id, userId);
}

export function getUserId(username: string): number {
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
  return row.id;
}

/* ---------------- 其他 ---------------- */

/** 轮询等待条件成立 */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10000, stepMs = 100): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 解析 zip 的 central directory，返回按写入顺序排列的条目名 */
export function readZipNames(buf: Buffer): string[] {
  // 找 End of Central Directory（PK\x05\x06），从尾部向前找（comment 可能为空）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** 读取 zip 中某个条目的完整内容（支持 store/deflate，通过 central directory 定位） */
export function readZipEntry(buf: Buffer, name: string): Buffer {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 24); // uncompressed size
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const entryName = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + (method === 0 ? size : buf.readUInt32LE(p + 20)));
      return method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry ${name} not found`);
}
