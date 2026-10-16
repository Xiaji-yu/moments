import crypto from 'node:crypto';
import { ISSUE_VALUES } from '../schema.js';
import type { AnalyzeInput, VisionProvider } from './types.js';

const TAG_POOL = ['海边', '合影', '美食', '日落', '街景', '山景', '宠物', '建筑', '夜景', '花草'];

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
};
