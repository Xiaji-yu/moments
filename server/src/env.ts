import fs from 'node:fs';
import path from 'node:path';

/** 解析 .env 内容（KEY=VALUE，支持 # 注释、引号、行内注释） */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

/**
 * 加载 .env 文件到 process.env（本地 dev 用）：
 * - 默认依次尝试 cwd/.env 与上一级目录的 .env（本地 dev 的 cwd 是 server/，项目 .env 在仓库根）；
 * - 已存在的环境变量不覆盖（Docker env_file / shell 导出的优先级更高）；
 * - 测试环境（VITEST）跳过，避免用户本地 Key 影响测试结果。
 */
export function loadDotEnv(files: string[] = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
]): void {
  if (process.env.VITEST) return;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const vars = parseEnvFile(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(vars)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export const dotenvDefaultPath = path.resolve(process.cwd(), '.env');
