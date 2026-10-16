import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import {
  createSession,
  getUserId,
  makeApp,
  makeJpeg,
  register,
  uploadDonePhoto,
  waitFor,
  type App,
} from '../helpers.js';

let app: App;
let token: string;
let userId: number;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'cropjob_user')).token;
  userId = getUserId('cropjob_user');
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const cropProgress = async (s: string) =>
  (await app.inject({ method: 'GET', url: `/api/sessions/${s}/crop-progress`, headers: auth(token) })).json();

/** 造 N 张已完成分析的会话 */
async function seedDoneSession(count: number, prefix: string): Promise<string> {
  const s = (await createSession(app, token)).id;
  for (let i = 0; i < count; i++) {
    const { photoId } = await uploadDonePhoto(app, token, s, userId, {
      name: `${prefix}${i}.jpg`,
      buf: await makeJpeg(400, 300, { r: 10 * i, g: 20, b: 30 }),
    });
    db.prepare(
      'INSERT INTO analyses (photo_id, score, tags, issues, reason) VALUES (?, ?, ?, ?, ?)',
    ).run(photoId, 7, '[]', '[]', '不错');
  }
  return s;
}

describe('批量构图建议：进度持久化与取消', () => {
  it('完成后 progress 从 running 落到 done=total', async () => {
    const s = await seedDoneSession(3, 'cj_ok_');
    const start = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    expect(start.statusCode).toBe(200);

    await waitFor(
      async () => {
        const p = await cropProgress(s);
        return !p.running && p.total > 0 && p.done >= p.total;
      },
      15000,
    );

    const p = await cropProgress(s);
    expect(p.total).toBe(3);
    expect(p.done).toBe(3);
    expect(p.cancelled).toBe(false);

    // 建议确实落库
    const rows = db.prepare('SELECT COUNT(*) AS c FROM crop_suggestions').all();
    expect((rows[0] as { c: number }).c).toBeGreaterThanOrEqual(3);
  });

  it('取消后 cancelled=true、任务退出、done < total', async () => {
    const s = await seedDoneSession(8, 'cj_cancel_');
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest/cancel`,
      payload: {},
      headers: auth(token),
    });
    expect(cancel.statusCode).toBe(200);

    await waitFor(async () => !(await cropProgress(s)).running, 15000);
    const p = await cropProgress(s);
    expect(p.cancelled).toBe(true);
    expect(p.done).toBeLessThan(p.total);
  });

  it('已有建议的照片默认被跳过；force=true 才重跑', async () => {
    const s = await seedDoneSession(2, 'cj_skip_');
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    await waitFor(async () => {
      const p = await cropProgress(s);
      return !p.running && p.done >= p.total && p.total > 0;
    }, 15000);

    // 再来一次：无可生成的 → total/done 复位为 0（前端据此提示「都已有建议」）
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    const p = await cropProgress(s);
    expect(p.total).toBe(0);
    expect(p.done).toBe(0);
    expect(p.running).toBe(false);
  });

  it('任务进行中再次启动 → 409', async () => {
    const s = await seedDoneSession(8, 'cj_busy_');
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: {},
      headers: auth(token),
    });
    expect(again.statusCode).toBe(409);
    // 清理：取消，避免影响后续文件
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest/cancel`,
      payload: {},
      headers: auth(token),
    });
  });

  it('photoIds 只给指定照片生成', async () => {
    const s = await seedDoneSession(3, 'cj_ids_');
    const ids = (db.prepare('SELECT id FROM photos WHERE session_id = ? ORDER BY created_at').all(s) as Array<{
      id: string;
    }>).map((r) => r.id);

    await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/crop-suggest`,
      payload: { photoIds: [ids[1]] },
      headers: auth(token),
    });
    await waitFor(async () => {
      const p = await cropProgress(s);
      return !p.running && p.total > 0 && p.done >= p.total;
    }, 15000);

    const p = await cropProgress(s);
    expect(p.total).toBe(1);
    expect(p.done).toBe(1);
    const having = db
      .prepare('SELECT photo_id FROM crop_suggestions')
      .all() as Array<{ photo_id: string }>;
    expect(having.map((r) => r.photo_id)).toContain(ids[1]);
  });
});
