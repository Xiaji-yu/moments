import crypto from 'node:crypto';
import { ISSUE_VALUES } from '../schema.js';
import { fitRatioBox, normRatio, type Ratio } from '../cropBox.js';
import type {
  AnalyzeInput,
  CaptionInput,
  ProviderResult,
  SuggestCropInput,
  TokenUsage,
  VisionProvider,
} from './types.js';

const TAG_POOL = ['海边', '合影', '美食', '日落', '街景', '山景', '宠物', '建筑', '夜景', '花草'];
const CROP_RATIOS: Ratio[] = ['original', '1:1', '3:4', '4:3', '16:9', '9:16'];
const CAPTION_TEMPLATES: Record<string, (tags: string[], note?: string) => string> = {
  简洁: (tags) => `${tags[0] ?? '出门'}｜今日份 ✅\n随手一拍，都很值得记录。`,
  文艺: (tags) => `把${tags[0] ?? '风景'}装进口袋 🌿\n风很温柔，光线刚刚好。\n有些瞬间，不发出来就浪费了。`,
  搞笑: (tags, note) => `镜头审美在线，本人仅负责出镜 😎\n${tags[0] ?? '今天'}拍成这样，下次继续卷。${note ? `\n（${note}）` : ''}`,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeUsage(): TokenUsage {
  return { input: crypto.randomInt(700, 1300), output: crypto.randomInt(50, 150) };
}

/** 无 Key 时的离线调试 Provider：确定性伪随机，走通全链路 */
export const mockProvider: VisionProvider = {
  id: 'mock',
  label: 'Mock 调试',
  models: ['mock-vision'],
  defaultModel: 'mock-vision',

  async analyzePhoto(input: AnalyzeInput): Promise<ProviderResult<unknown>> {
    await sleep(250 + crypto.randomInt(400));
    const seed = crypto
      .createHash('md5')
      .update(input.hint?.filename ?? crypto.randomBytes(8).toString('hex'))
      .digest();
    const score = 3 + (seed[0] % 7); // 3..9
    const t1 = TAG_POOL[seed[1] % TAG_POOL.length];
    const t2 = TAG_POOL[seed[2] % TAG_POOL.length];
    const tags = [...new Set([t1, t2])];
    const issues = seed[3] < 46 ? [ISSUE_VALUES[seed[4] % ISSUE_VALUES.length]] : [];
    // 评语与分数联动，避免「低分却好评」的误导
    const reason = issues.length
      ? `画面存在${issues.join('、')}问题，质量欠佳。`
      : score >= 7
        ? `${tags.join('、')}主题明确，光线与构图状态不错，适合发朋友圈。`
        : score >= 5
          ? `${tags.join('、')}主题尚可，整体中规中矩，还有提升空间。`
          : `${tags.join('、')}主体不够突出，画面平淡，不建议直接发出。`;
    return { data: { score, tags, issues, reason }, usage: fakeUsage() };
  },

  async suggestCrop(input: SuggestCropInput): Promise<ProviderResult<unknown>> {
    await sleep(200 + crypto.randomInt(300));
    const seed = crypto.createHash('md5').update(input.hint?.filename ?? 'crop').digest();
    const width = input.width > 0 ? input.width : 4;
    const height = input.height > 0 ? input.height : 3;
    const landscape = width >= height;

    // 只推荐与图片朝向相容的比例（横图不裁 9:16 竖框，竖图不裁 16:9 横框）
    const pool = CROP_RATIOS.filter((r) => {
      if (r === 'original') return true;
      const vertical = r === '9:16' || r === '3:4';
      return landscape ? !vertical : vertical;
    });
    const ratio = pool[seed[5] % pool.length];
    const r = normRatio(ratio, width, height);

    // 主体中心放在三分点附近（0.33~0.66），裁剪范围取最大内接框的 55%~85%
    const cx = 1 / 3 + (seed[6] % 34) / 100;
    const cy = 1 / 3 + (seed[7] % 34) / 100;
    const max = fitRatioBox(cx, cy, r);
    const scale = 0.55 + (seed[8] % 31) / 100;
    const box = {
      x: max.x + (max.w * (1 - scale)) / 2,
      y: max.y + (max.h * (1 - scale)) / 2,
      w: max.w * scale,
      h: max.h * scale,
    };
    const reasoning =
      ratio === 'original'
        ? '保留原始比例，收紧画面剔除边缘干扰，主体更突出。'
        : `采用 ${ratio} 比例二次构图，主体置于三分点附近，剔除边缘干扰。`;
    // subject 与框中心一致：mock 不识别画面内容，但输出结构与真实 provider 保持相同
    return { data: { ratio, subject: { x: cx, y: cy }, box, reasoning }, usage: fakeUsage() };
  },

  async generateCaptions(input: CaptionInput): Promise<ProviderResult<string[]>> {
    await sleep(300 + crypto.randomInt(400));
    const seed = crypto.createHash('md5').update(input.tags.join(',') + input.style).digest();
    const shuffled = [...input.tags].sort((a, b) => a.localeCompare(b, 'zh'));
    const picked = shuffled.slice(0, 2);
    const styleOf = (i: number): string =>
      input.style === '混合' ? ['简洁', '文艺', '搞笑'][i % 3] : input.style;
    const captions = [0, 1, 2].map((i) => {
      const tags = i === 2 ? [...picked].reverse() : picked;
      const base = CAPTION_TEMPLATES[styleOf(i)](tags, input.note);
      return `${base}${seed[i] % 2 ? ' ✨' : ''}`;
    });
    return { data: captions, usage: { input: crypto.randomInt(300, 600), output: crypto.randomInt(80, 200) } };
  },
};
