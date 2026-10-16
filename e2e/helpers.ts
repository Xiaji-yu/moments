import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';

/** 生成一张纯色 JPEG（无需落盘，直接给 setInputFiles 用） */
export async function makeJpegBuffer(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 600, channels: 3, background: color } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function registerUser(page: Page): Promise<string> {
  const username = `e2e_${Date.now().toString(36)}`;
  await page.goto('/login');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByPlaceholder('用户名（3~20 位字母/数字/下划线）').fill(username);
  await page.getByPlaceholder('密码（≥8 位，含字母和数字）').fill('passw0rd1');
  await page.getByRole('button', { name: '注册并进入' }).click();
  // 等工作区初始化完成：会话 id 落入 localStorage 后才算就绪。
  // 否则上传区虽已渲染，sessionId 仍为空，上传会被静默忽略（竞态）。
  await page.waitForFunction(() => !!localStorage.getItem('moments_session'), null, {
    timeout: 30_000,
  });
  await expect(page.getByText(/拖拽照片到这里/)).toBeVisible({ timeout: 30_000 });
  return username;
}

export async function uploadPhotos(page: Page, files: Array<{ name: string; buffer: Buffer }>): Promise<void> {
  await page.setInputFiles(
    'input[type="file"]',
    files.map((f) => ({ name: f.name, mimeType: 'image/jpeg', buffer: f.buffer })),
  );
  await expect(page.getByText(/导入完成：成功 \d+ 张/)).toBeVisible({ timeout: 60_000 });
}

/** 等待指定数量的缩略图加载完成 */
export async function expectThumbs(page: Page, count: number): Promise<void> {
  await expect(page.locator('img')).toHaveCount(count, { timeout: 30_000 });
}

export function fixtureDir(): string {
  const dir = path.join(tmpdir(), 'moments-e2e-fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export { expect, test };
