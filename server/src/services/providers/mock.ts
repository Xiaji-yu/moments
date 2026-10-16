import crypto from 'node:crypto';
import { ISSUE_VALUES } from '../schema.js';
import { fitRatioBox, normRatio, type Ratio } from '../cropBox.js';
import type { AnalyzeInput, SuggestCropInput, VisionProvider } from './types.js';

const TAG_POOL = ['海边', '合影', '美食', '日落', '街景', '山景', '宠物', '建筑', '夜景', '花草'];
const CROP_RATIOS: Ratio[] = ['original', '1:1', '3:4', '4:3', '16:9', '9:16'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 无 Key 时的离线调试 Provider：确定性伪随机，走通全链路 */
export const mockProvider: VisionProvider = {
  id: 'mock',
  label: 'Mock 调试',
  models: ['mock-vision'],
  defaultModel: 'mock-vision',
  async analyzePhoto(input: AnalyzeInput) {
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
    const reason = issues.length
      ? `画面存在${issues.join('、')}问题，质量欠佳。`
      : `${tags.join('、')}主题明确，光线与构图状态不错，适合发朋友圈。`;
    return { score, tags, issues, reason };
  },

  async suggestCrop(input: SuggestCropInput) {
    await sleep(200 + crypto.randomInt(300));
    const seed = crypto.createHash('md5').update(input.hint?.filename ?? 'crop').digest();
    const width = input.width > 0 ? input.width : 4;
    const height = input.height > 0 ? input.height : 3;

    const ratio = CROP_RATIOS[seed[5] % CROP_RATIOS.length];
    const r = normRatio(ratio, width, height);
    // 中心落在三分点附近，取该比例最大内接框的 70%~95%
    const cx = 1 / 3 + (seed[6] % 34) / 100;
    const cy = 1 / 3 + (seed[7] % 34) / 100;
    const max = fitRatioBox(cx, cy, r);
    const scale = 0.7 + (seed[8] % 26) / 100;
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
    return { ratio, box, reasoning };
  },
};
