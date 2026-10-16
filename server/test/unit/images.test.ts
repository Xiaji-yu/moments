import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hammingHex, pHashOf, processImage } from '../../src/services/images.js';
import { jpegWithExif, makeJpeg } from '../helpers.js';

describe('hammingHex（pHash 汉明距离）', () => {
  it('相同串距离为 0', () => {
    expect(hammingHex('deadbeefdeadbeef', 'deadbeefdeadbeef')).toBe(0);
  });

  it('单 bit 差异距离为 1', () => {
    expect(hammingHex('0000000000000000', '0000000000000001')).toBe(1);
  });

  it('全 0 与全 f 距离为 64', () => {
    expect(hammingHex('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('典型相似度分档', () => {
    expect(hammingHex('0123456789abcdef', '0123456789abcdee')).toBe(1);
    expect(hammingHex('aaaaaaaaaaaaaaaa', '5555555555555555')).toBe(64);
  });
});

describe('pHashOf（DCT 感知哈希）', () => {
  it('返回 16 位 hex', async () => {
    const img = await makeJpeg(64, 64, { r: 100, g: 120, b: 140 });
    const h = await pHashOf(img);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('相同图片哈希稳定', async () => {
    const img = await makeJpeg(200, 200, { r: 10, g: 200, b: 30 });
    expect(await pHashOf(img)).toBe(await pHashOf(img));
  });

  it('轻微位移/亮度变化后汉明距离小（相似聚类的前提）', async () => {
    // 纯色图的 DCT 高频全零、pHash 退化，必须有结构内容才贴近真实照片
    const makeShape = async (dx: number) =>
      sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 30, g: 60, b: 200 } } })
        .composite([{ input: await makeJpeg(100, 100, { r: 220, g: 30, b: 30 }), left: 100 + dx, top: 100 }])
        .jpeg()
        .toBuffer();
    const base = await makeShape(0);
    const shifted = await makeShape(4);
    const d = hammingHex(await pHashOf(base), await pHashOf(shifted));
    expect(d).toBeLessThanOrEqual(8);
  });

  it('内容截然不同的图距离大', async () => {
    // 左右渐变 vs 上下渐变，DCT 结构差异明显
    const hGrad = await sharp({
      create: { width: 200, height: 200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
    }).jpeg().toBuffer();
    const vGrad = await sharp({
      create: { width: 200, height: 200, channels: 3, noise: { type: 'gaussian', mean: 60, sigma: 10 } },
    }).jpeg().toBuffer();
    const d = hammingHex(await pHashOf(hGrad), await pHashOf(vGrad));
    expect(d).toBeGreaterThan(8);
  });
});

describe('processImage（导入管线：方向纠正 / 尺寸 / 去重哈希 / 时间回退）', () => {
  it('输出三种规格且长边受限', async () => {
    const input = await makeJpeg(4000, 3000, { r: 50, g: 150, b: 200 });
    const out = await processImage(input, Date.now());

    expect(out.width).toBe(4000);
    expect(out.height).toBe(3000);

    const origMeta = await sharp(out.original).metadata();
    expect(origMeta.width).toBe(4000);
    expect(origMeta.format).toBe('jpeg');

    const thumbMeta = await sharp(out.thumb).metadata();
    expect(Math.max(thumbMeta.width!, thumbMeta.height!)).toBeLessThanOrEqual(480);

    const sendMeta = await sharp(out.send).metadata();
    expect(Math.max(sendMeta.width!, sendMeta.height!)).toBeLessThanOrEqual(1024);
  });

  it('小图不放大', async () => {
    const input = await makeJpeg(120, 80, { r: 1, g: 2, b: 3 });
    const out = await processImage(input, Date.now());
    const thumbMeta = await sharp(out.thumb).metadata();
    expect(thumbMeta.width).toBe(120);
    expect(thumbMeta.height).toBe(80);
  });

  it('sha256 基于纠正后的图像内容，可做完全重复去重', async () => {
    const input = await makeJpeg(500, 300, { r: 90, g: 20, b: 180 });
    const a = await processImage(input, 1700000000000);
    const b = await processImage(input, 1800000000000);
    expect(a.hash).toBe(b.hash);

    // 差异要超过 JPEG 量化的感知阈值，否则两图可能被压成相同字节
    const other = await makeJpeg(500, 300, { r: 220, g: 40, b: 40 });
    const c = await processImage(other, 1700000000000);
    expect(c.hash).not.toBe(a.hash);
  });

  it('无 EXIF 时 hasExif=false，拍摄时间回退文件时间', async () => {
    const input = await makeJpeg(100, 100, { r: 5, g: 5, b: 5 });
    const out = await processImage(input, 1700000000000);
    expect(out.hasExif).toBe(false);
    expect(out.takenAt).toBe(new Date(1700000000000).toISOString());
  });

  it('EXIF 方向纠正：Orientation=6 的 100x50 竖拍原图输出为 50x100，且元数据被剥离', async () => {
    const input = await jpegWithExif(100, 50, { r: 200, g: 100, b: 50 }, { orientation: 6 });
    const out = await processImage(input, Date.now());

    expect(out.width).toBe(50);
    expect(out.height).toBe(100);
    const meta = await sharp(out.original).metadata();
    expect(meta.exif).toBeUndefined(); // GPS 等隐私元数据不保留
  });

  it('EXIF 拍摄时间被解析（GPS 等其余元数据不读取不保留）', async () => {
    const input = await jpegWithExif(80, 80, { r: 10, g: 10, b: 10 }, {
      dateStr: '2024:06:01 12:00:00',
    });
    const out = await processImage(input, 999);
    expect(out.hasExif).toBe(true);
    expect(out.takenAt).toBe('2024-06-01T12:00:00.000Z');
  });

  it('损坏的图片字节直接抛错（上传层转为 failed）', async () => {
    await expect(processImage(Buffer.from('this is not an image'), Date.now())).rejects.toThrow();
  });
});
