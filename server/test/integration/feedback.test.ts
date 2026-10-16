import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import {
  createSession,
  getUserId,
  makeApp,
  makeJpeg,
  register,
  uploadDonePhoto,
  type App,
} from '../helpers.js';

let app: App;
let token: string;
let tokenOther: string;
let userId: number;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'fb_user')).token;
  tokenOther = (await register(app, 'fb_other')).token;
  userId = getUserId('fb_user');
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function seedAnalyzedPhoto(): Promise<{ s: string; photoId: string }> {
  const s = (await createSession(app, token)).id;
  const { photoId } = await uploadDonePhoto(app, token, s, userId, {
    name: 'fb.jpg',
    buf: await makeJpeg(400, 300, { r: 12, g: 34, b: 56 }),
  });
  // uploadDonePhoto 只标 status，这里补一条分析结果供反馈
  db.prepare(
    'INSERT INTO analyses (photo_id, score, tags, issues, reason, feedback) VALUES (?, ?, ?, ?, ?, 0)',
  ).run(photoId, 7, '["海边"]', '[]', '不错');
  return { s, photoId };
}

describe('PUT /api/photos/:id/feedback（挑图反馈闭环）', () => {
  it('点赞后 GET 会话反映 feedback=1', async () => {
    const { s, photoId } = await seedAnalyzedPhoto();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/feedback`,
      payload: { feedback: 1 },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feedback).toBe(1);

    const detail = (
      await app.inject({ method: 'GET', url: `/api/sessions/${s}`, headers: auth(token) })
    ).json();
    expect(detail.photos[0].analysis.feedback).toBe(1);
  });

  it('点踩记为 -1，再传 0 可清除', async () => {
    const { photoId } = await seedAnalyzedPhoto();
    await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/feedback`,
      payload: { feedback: -1 },
      headers: auth(token),
    });
    let row = db.prepare('SELECT feedback FROM analyses WHERE photo_id = ?').get(photoId) as {
      feedback: number;
    };
    expect(row.feedback).toBe(-1);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/feedback`,
      payload: { feedback: 0 },
      headers: auth(token),
    });
    expect(res.json().feedback).toBe(0);
    row = db.prepare('SELECT feedback FROM analyses WHERE photo_id = ?').get(photoId) as {
      feedback: number;
    };
    expect(row.feedback).toBe(0);
  });

  it('非法值（如 5）归零而不是写入', async () => {
    const { photoId } = await seedAnalyzedPhoto();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/feedback`,
      payload: { feedback: 5 },
      headers: auth(token),
    });
    expect(res.json().feedback).toBe(0);
  });

  it('对没有分析结果的照片反馈 → 409', async () => {
    const s = (await createSession(app, token)).id;
    const { photoId } = await uploadDonePhoto(app, token, s, userId, {
      name: 'noanalysis.jpg',
      buf: await makeJpeg(200, 200, { r: 1, g: 1, b: 1 }),
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/feedback`,
      payload: { feedback: 1 },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(409);
  });

  it('越权反馈 → 404', async () => {
    const { photoId } = await seedAnalyzedPhoto();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/photos/${photoId}/feedback`,
      payload: { feedback: 1 },
      headers: auth(tokenOther),
    });
    expect(res.statusCode).toBe(404);
  });
});
