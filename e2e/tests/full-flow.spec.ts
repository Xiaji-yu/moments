import { expect, makeJpegBuffer, registerUser, test, uploadPhotos } from '../helpers';

test('注册 → 导入 → AI 分析 → 挑图 → 构图建议 → 导出 全流程（Mock 供应商）', async ({ page }) => {
  // 1. 注册进入工作区
  await registerUser(page);

  // 2. 批量导入 3 张照片
  const colors = [
    { r: 220, g: 60, b: 40 },
    { r: 40, g: 180, b: 90 },
    { r: 60, g: 90, b: 230 },
  ];
  const files = await Promise.all(
    colors.map(async (c, i) => ({ name: `trip_${i}.jpg`, buffer: await makeJpegBuffer(c) })),
  );
  await uploadPhotos(page, files);
  await expect(page.getByText('待分析')).toHaveCount(3);
  await expect(page.getByText(/开始 AI 分析（3 张）/)).toBeVisible();

  // 3. AI 分析（Mock 供应商）→ 全部完成
  await page.getByRole('button', { name: /开始 AI 分析/ }).click();
  await expect(page.getByText(/分析完成：成功 3 张/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('完成', { exact: true })).toHaveCount(3);
  // 评分徽标出现
  await expect(page.getByText(/\d+ 分/).first()).toBeVisible();

  // 4. AI 挑图 → 推荐结果 + 落选列表
  await page.getByRole('button', { name: 'AI 挑图' }).click();
  await expect(page.getByText(/🏆 AI 推荐 \d+ 张/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/落选照片（\d+）/)).toBeVisible();

  // 5. 批量生成构图建议（有推荐结果时按钮文案为「为推荐 N 张生成构图」）
  await page.getByRole('button', { name: /生成构图/ }).click();
  await expect(page.getByText(/构图建议完成/)).toBeVisible({ timeout: 60_000 });

  // 6. 导出 zip（浏览器下载）
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: /导出推荐|导出 zip/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^moments-.*\.zip$/);
});

test('登录已有账号 → 会话恢复（NFR-13）', async ({ page, browser }) => {
  // 先注册拿到账号
  await registerUser(page);
  const username = await page.locator('header span.md\\:inline').textContent();
  // 退出
  await page.getByRole('button', { name: '退出' }).click();
  await page.waitForURL(/\/login/);

  // 用同一浏览器上下文重新登录：localStorage 中 moments_session 已被清除
  await page.getByPlaceholder('用户名（3~20 位字母/数字/下划线）').fill(username!);
  await page.getByPlaceholder('密码（≥8 位，含字母和数字）').fill('passw0rd1');
  await page.locator('form').getByRole('button', { name: '登录' }).click();
  await expect(page.getByText(/拖拽照片到这里/)).toBeVisible({ timeout: 30_000 });
  void browser;
});

test('登录失败有统一错误提示（AC-F11-2）', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('用户名（3~20 位字母/数字/下划线）').fill('no_such_user');
  await page.getByPlaceholder('密码（≥8 位，含字母和数字）').fill('wrongpass9');
  await page.locator('form').getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('用户名或密码错误')).toBeVisible();
});

test('重复上传同一张图被去重（AC-F1-5）', async ({ page }) => {
  await registerUser(page);
  const buf = await makeJpegBuffer({ r: 200, g: 100, b: 30 });
  await uploadPhotos(page, [{ name: 'dup.jpg', buffer: buf }]);
  await page.setInputFiles('input[type="file"]', [
    { name: 'dup.jpg', mimeType: 'image/jpeg', buffer: buf },
  ]);
  await expect(page.getByText(/跳过重复 1 张/)).toBeVisible({ timeout: 60_000 });
});

test('分析中可取消，取消后按钮恢复可用', async ({ page }) => {
  await registerUser(page);
  // 12 张图：给「取消」留出足够的执行窗口
  const files = await Promise.all(
    Array.from({ length: 12 }, async (_, i) => ({
      name: `cancel_${i}.jpg`,
      buffer: await makeJpegBuffer({ r: (i * 20) % 250, g: 60, b: 120 }),
    })),
  );
  await uploadPhotos(page, files);
  await page.getByRole('button', { name: /开始 AI 分析/ }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();

  // 取消后轮询停止，主按钮恢复
  await expect(page.getByRole('button', { name: /开始 AI 分析（12 张）/ })).toBeEnabled({ timeout: 30_000 });
});

test('挑图反馈 👍 刷新后保持（反馈闭环持久化）', async ({ page }) => {
  await registerUser(page);
  const files = await Promise.all([
    { name: 'fb_0.jpg', buffer: await makeJpegBuffer({ r: 200, g: 50, b: 50 }) },
    { name: 'fb_1.jpg', buffer: await makeJpegBuffer({ r: 50, g: 200, b: 50 }) },
  ]);
  await uploadPhotos(page, files);
  await page.getByRole('button', { name: /开始 AI 分析/ }).click();
  await expect(page.getByText(/分析完成：成功 2 张/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'AI 挑图' }).click();
  await expect(page.getByText(/🏆 AI 推荐/)).toBeVisible({ timeout: 30_000 });

  await page.getByTitle('挑得好，以后多来点').first().click();
  await expect(page.getByTitle('挑得好，以后多来点').first()).toHaveClass(/bg-blue-100/);

  // 刷新后从后端恢复，反馈应仍在
  await page.reload();
  await expect(page.getByTitle('挑得好，以后多来点').first()).toHaveClass(/bg-blue-100/, {
    timeout: 30_000,
  });
});
