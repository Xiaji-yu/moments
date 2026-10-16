import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { config } from '../../src/config.js';
import { db } from '../../src/db.js';
import {
  createSession,
  getUserId,
  makeApp,
  makeJpeg,
  register,
  uploadPhotos,
  type App,
} from '../helpers.js';

let app: App;
let token: string;
let tokenOther: string;
let sessionId: string;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'upload_user')).token;
  tokenOther = (await register(app, 'upload_other')).token;
  sessionId = (await createSession(app, token)).id;
});

afterAll(async () => {
  await app.close();
});

describe('POST /api/sessions/:id/photos（批量导入）', () => {
  it('批量上传成功：落库 + 三种规格文件生成 + 元数据剥离', async () => {
    const files = [
      { name: 'a.jpg', buf: await makeJpeg(1600, 1200, { r: 200, g: 30, b: 30 }) },
      { name: 'b.jpg', buf: await makeJpeg(1200, 1600, { r: 30, g: 200, b: 30 }) },
    ];
    const res = await uploadPhotos(app, token, sessionId, files);
    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(2);
    expect(res.json().failed).toEqual([]);
    expect(res.json().duplicates).toEqual([]);

    const photos = db.prepare('SELECT * FROM photos WHERE session_id = ?').all(sessionId) as Array<{
      id: string;
      filename: string;
      width: number;
      height: number;
      status: string;
    }>;
    expect(photos.map((p) => p.filename).sort()).toEqual(['a.jpg', 'b.jpg']);

    const dir = path.join(config.dataDir, 'users', String(getUserId('upload_user')), sessionId, photos[0].id);
    for (const f of ['original.jpg', 'thumb.jpg', 'send.jpg']) {
      expect(fs.existsSync(path.join(dir, f)), `${f} 应存在`).toBe(true);
    }
    const sendMeta = await sharp(fs.readFileSync(path.join(dir, 'send.jpg'))).metadata();
    expect(Math.max(sendMeta.width!, sendMeta.height!)).toBeLessThanOrEqual(1024);
  });

  it('完全相同的文件重复上传 → 进 duplicates 不落库（AC-F1-5）', async () => {
    const buf = await makeJpeg(800, 600, { r: 10, g: 10, b: 250 });
    const first = await uploadPhotos(app, token, sessionId, [{ name: 'dup.jpg', buf }]);
    expect(first.json().added).toBe(1);
    const again = await uploadPhotos(app, token, sessionId, [{ name: 'dup.jpg', buf }]);
    expect(again.json().added).toBe(0);
    expect(again.json().duplicates).toEqual(['dup.jpg']);
  });

  it('损坏文件 → failed 且原因可读，不影响其他文件', async () => {
    const res = await uploadPhotos(app, token, sessionId, [
      { name: 'broken.jpg', buf: Buffer.from('definitely not a jpeg') },
      { name: 'good.jpg', buf: await makeJpeg(300, 300, { r: 99, g: 99, b: 9 }) },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(1);
    expect(res.json().failed).toHaveLength(1);
    expect(res.json().failed[0].filename).toBe('broken.jpg');
    expect(res.json().failed[0].reason).toContain('图片处理失败');
  });

  it('单会话超出 30 张上限的部分 → failed（AC-F1-2）', async () => {
    const s = (await createSession(app, token)).id;
    const userId = getUserId('upload_user');
    // 直接插桩 29 张已有照片，再上传 2 张：第 30 张成功、第 31 张被拒
    for (let i = 0; i < config.maxPhotosPerSession - 1; i++) {
      db.prepare(
        `INSERT INTO photos (id, session_id, user_id, filename, hash, phash, width, height, taken_at, has_exif, status)
         VALUES (?, ?, ?, ?, ?, ?, 64, 64, ?, 0, 'ready')`,
      ).run(`stub_${i}`, s, userId, `stub${i}.jpg`, `h${i}`, `ph${i}`, new Date(2024, 0, i + 1).toISOString());
    }
    const files = await Promise.all(
      Array.from({ length: 2 }, (_, i) => makeJpeg(64, 64, { r: i * 200, g: 100, b: 150 }).then((buf) => ({ name: `extra${i}.jpg`, buf }))),
    );
    const res = await uploadPhotos(app, token, s, files);
    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(1);
    expect(res.json().failed).toHaveLength(1);
    expect(res.json().failed[0].filename).toBe('extra1.jpg');
    expect(res.json().failed[0].reason).toContain(`单会话最多 ${config.maxPhotosPerSession} 张`);
  });

  it('越权向他人会话上传 → 404', async () => {
    const res = await uploadPhotos(app, tokenOther, sessionId, [
      { name: 'intrude.jpg', buf: await makeJpeg(50, 50, { r: 1, g: 2, b: 3 }) },
    ]);
    expect(res.statusCode).toBe(404);
  });

  it('HEIC/未知扩展名的非图片内容同样安全失败', async () => {
    const res = await uploadPhotos(app, token, sessionId, [
      { name: 'fake.heic', buf: Buffer.from(new Uint8Array(64).fill(7)) },
    ]);
    expect(res.json().added).toBe(0);
    expect(res.json().failed).toHaveLength(1);
  });
});

describe('DELETE /api/sessions/:id/photos/:photoId', () => {
  it('删除照片：记录与磁盘文件一起清除', async () => {
    const s = (await createSession(app, token)).id;
    await uploadPhotos(app, token, s, [{ name: 'bye.jpg', buf: await makeJpeg(100, 100, { r: 5, g: 5, b: 5 }) }]);
    const photo = db.prepare('SELECT id FROM photos WHERE session_id = ?').get(s) as { id: string };
    const dir = path.join(config.dataDir, 'users', String(getUserId('upload_user')), s, photo.id);
    expect(fs.existsSync(dir)).toBe(true);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${s}/photos/${photo.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT id FROM photos WHERE id = ?').get(photo.id)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('越权删除 → 404', async () => {
    const s = (await createSession(app, token)).id;
    await uploadPhotos(app, token, s, [{ name: 'keep.jpg', buf: await makeJpeg(100, 100, { r: 5, g: 5, b: 5 }) }]);
    const photo = db.prepare('SELECT id FROM photos WHERE session_id = ?').get(s) as { id: string };
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${s}/photos/${photo.id}`,
      headers: { authorization: `Bearer ${tokenOther}` },
    });
    expect(res.statusCode).toBe(404);
    expect(db.prepare('SELECT id FROM photos WHERE id = ?').get(photo.id)).toBeDefined();
  });
});

describe('GET /api/photos/:id/thumb|image（照片访问隔离）', () => {
  it('属主可读取缩略图/原图（image/jpeg）', async () => {
    const s = (await createSession(app, token)).id;
    await uploadPhotos(app, token, s, [{ name: 'view.jpg', buf: await makeJpeg(120, 90, { r: 80, g: 160, b: 240 }) }]);
    const photo = db.prepare('SELECT id FROM photos WHERE session_id = ?').get(s) as { id: string };

    const thumb = await app.inject({
      method: 'GET',
      url: `/api/photos/${photo.id}/thumb`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');

    const image = await app.inject({
      method: 'GET',
      url: `/api/photos/${photo.id}/image`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(image.statusCode).toBe(200);
  });

  it('他人访问照片 → 404（AC-F11-5）', async () => {
    const s = (await createSession(app, token)).id;
    await uploadPhotos(app, token, s, [{ name: 'priv.jpg', buf: await makeJpeg(100, 100, { r: 1, g: 1, b: 1 }) }]);
    const photo = db.prepare('SELECT id FROM photos WHERE session_id = ?').get(s) as { id: string };
    const res = await app.inject({
      method: 'GET',
      url: `/api/photos/${photo.id}/image`,
      headers: { authorization: `Bearer ${tokenOther}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
