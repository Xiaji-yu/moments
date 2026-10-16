import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { db } from '../../src/db.js';
import {
  createSession,
  getUserId,
  insertAnalysisRow,
  insertPhotoRow,
  insertSessionRow,
  makeApp,
  makeJpeg,
  readZipEntry,
  readZipNames,
  register,
  uploadDonePhoto,
  waitFor,
  type App,
} from '../helpers.js';

let app: App;
let token: string;
let tokenOther: string;
let userId: number;

beforeAll(async () => {
  app = (await makeApp({ rateLimit: false })) as App;
  token = (await register(app, 'exp_user')).token;
  tokenOther = (await register(app, 'exp_other')).token;
  userId = getUserId('exp_user');
});

afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 造一个「分析完成 + 已保存文案」的会话，返回 sessionId 与两张照片 id */
async function seedExportableSession(): Promise<{ s: string; p1: string; p2: string }> {
  const s = (await createSession(app, token)).id;
  const { photoId: p1 } = await uploadDonePhoto(app, token, s, userId, {
    name: 'first.jpg',
    buf: await makeJpeg(600, 400, { r: 180, g: 30, b: 30 }),
  });
  const { photoId: p2 } = await uploadDonePhoto(app, token, s, userId, {
    name: 'second.jpg',
    buf: await makeJpeg(400, 600, { r: 30, g: 30, b: 180 }),
  });
  insertAnalysisRow(p1, { score: 8 });
  insertAnalysisRow(p2, { score: 7 });
  await app.inject({
    method: 'PUT',
    url: `/api/sessions/${s}/caption`,
    payload: { items: [{ style: '简洁', text: '测试文案' }] },
    headers: auth(token),
  });
  return { s, p1, p2 };
}

describe('GET /api/sessions/:id/usage（token 用量，NFR-2）', () => {
  it('完整分析后统计调用次数与 token', async () => {
    const s = (await createSession(app, token)).id;
    await uploadDonePhoto(app, token, s, userId, { name: 'u1.jpg', buf: await makeJpeg(400, 300, { r: 1, g: 2, b: 3 }) });
    await uploadDonePhoto(app, token, s, userId, { name: 'u2.jpg', buf: await makeJpeg(300, 400, { r: 3, g: 2, b: 1 }) });
    await app.inject({ method: 'POST', url: `/api/sessions/${s}/analyze`, payload: {}, headers: auth(token) });
    await waitFor(async () => {
      const p = (
        await app.inject({ method: 'GET', url: `/api/sessions/${s}/progress`, headers: auth(token) })
      ).json();
      return !p.running && p.done === 2;
    });

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s}/usage`, headers: auth(token) });
    const usage = res.json();
    expect(usage.calls).toBe(2);
    expect(usage.input).toBeGreaterThan(0);
    expect(usage.output).toBeGreaterThan(0);
    expect(usage.costEstimate).toBeNull(); // 未配置单价
  });

  it('配置 COST_PER_1M_* 后给出费用估算', async () => {
    const s = (await createSession(app, token)).id;
    insertSessionRow('usage_cost', userId);
    db.prepare(
      'INSERT INTO model_usage (session_id, kind, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
    ).run('usage_cost', 'analysis', 'm', 1_000_000, 500_000);

    vi.stubEnv('COST_PER_1M_INPUT', '10');
    vi.stubEnv('COST_PER_1M_OUTPUT', '20');
    const res = await app.inject({ method: 'GET', url: '/api/sessions/usage_cost/usage', headers: auth(token) });
    const usage = res.json();
    expect(usage.costEstimate).toBeCloseTo(10 + 0.5 * 20);
  });

  it('无调用记录时全 0', async () => {
    vi.unstubAllEnvs(); // 避免前一个用例的单价 stub 泄漏
    insertSessionRow('usage_zero', userId);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/usage_zero/usage', headers: auth(token) });
    expect(res.json()).toEqual({ calls: 0, input: 0, output: 0, costEstimate: null });
  });

  it('越权读取他人用量 → 404', async () => {
    insertSessionRow('usage_priv', userId);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/usage_priv/usage', headers: auth(tokenOther) });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/sessions/:id/export（打包导出，AC-F9）', () => {
  it('按 photoIds 传入顺序导出 zip，并附带 caption.txt（AC-F9-1/2）', async () => {
    const { s, p1, p2 } = await seedExportableSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export`,
      payload: { photoIds: [p2, p1] }, // 故意逆序
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');

    const names = readZipNames(res.rawPayload);
    expect(names).toEqual(['01_second.jpg', '02_first.jpg', 'caption.txt']);
    const caption = readZipEntry(res.rawPayload, 'caption.txt').toString('utf8');
    expect(caption).toBe('测试文案');
  });

  it('应用裁剪的照片按原图坐标裁剪导出（AC-F9-2/4）', async () => {
    const { s, p1 } = await seedExportableSession();
    // p1 是 600x400；保存一个 1:1 裁剪（归一空间 w/h = 400/600 ≈ 0.667）
    await app.inject({
      method: 'PUT',
      url: `/api/photos/${p1}/crop`,
      payload: { ratio: '1:1', box: { x: 0.25, y: 0, w: 0.6675, h: 1 } },
      headers: auth(token),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export`,
      payload: { photoIds: [p1] },
      headers: auth(token),
    });
    const jpg = readZipEntry(res.rawPayload, '01_first.jpg');
    const meta = await sharp(jpg).metadata();
    // 裁剪后的宽高比应为 1:1（保留 normalizeBox 的取整误差）
    expect(Math.abs(meta.width! / meta.height! - 1)).toBeLessThan(0.05);
  });

  it('不传 photoIds 时按拍摄时间导出全部 done 照片', async () => {
    const { s } = await seedExportableSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export`,
      payload: {},
      headers: auth(token),
    });
    const names = readZipNames(res.rawPayload);
    expect(names.filter((n) => n !== 'caption.txt')).toHaveLength(2);
    expect(names[0]).toBe('01_first.jpg'); // 上传早者在前
  });

  it('文件名中的非法字符被替换', async () => {
    const s = (await createSession(app, token)).id;
    const { photoId } = await uploadDonePhoto(app, token, s, userId, {
      name: 'bad:name?1*.jpg',
      buf: await makeJpeg(100, 100, { r: 2, g: 2, b: 2 }),
    });
    insertAnalysisRow(photoId, { score: 5 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export`,
      payload: { photoIds: [photoId] },
      headers: auth(token),
    });
    const names = readZipNames(res.rawPayload);
    expect(names[0]).toBe('01_bad_name_1_.jpg');
  });

  it('没有可导出照片 → 409', async () => {
    insertSessionRow('exp_none', userId);
    insertPhotoRow({ id: 'exp_none_p', sessionId: 'exp_none', userId, status: 'ready' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/exp_none/export',
      payload: {},
      headers: auth(token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('没有可导出的照片');
  });

  it('越权导出他人会话 → 404', async () => {
    const { s } = await seedExportableSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s}/export`,
      payload: {},
      headers: auth(tokenOther),
    });
    expect(res.statusCode).toBe(404);
  });
});
