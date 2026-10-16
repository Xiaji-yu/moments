import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv, parseEnvFile } from '../../src/env.js';

afterEach(() => {
  delete process.env.A_SIMPLE;
  delete process.env.B_QUOTED;
  delete process.env.C_COMMENT;
  delete process.env.D_EMPTY;
  delete process.env.E_HASH;
  delete process.env.F_PRESET;
});

describe('parseEnvFile（.env 解析）', () => {
  it('解析 KEY=VALUE、引号、行内注释与空值', () => {
    const vars = parseEnvFile(
      [
        '# 注释行',
        '',
        'A_SIMPLE=hello',
        'B_QUOTED="with spaces and: colon"',
        "SINGLE='single quoted'",
        'C_COMMENT=value # trailing comment',
        'D_EMPTY=',
        'E_HASH=abc#123', // 值中无空格前缀的 # 不算注释
        'BAD LINE WITHOUT EQUALS',
        '1BAD=invalid key',
      ].join('\n'),
    );
    expect(vars).toEqual({
      A_SIMPLE: 'hello',
      B_QUOTED: 'with spaces and: colon',
      SINGLE: 'single quoted',
      C_COMMENT: 'value',
      D_EMPTY: '',
      E_HASH: 'abc#123',
    });
  });
});

describe('loadDotEnv', () => {
  it('VITEST 环境下跳过加载（防止本地 Key 污染测试）', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env');
    fs.writeFileSync(file, 'A_SIMPLE=leaked');
    process.env.VITEST = 'true';
    loadDotEnv(file);
    expect(process.env.A_SIMPLE).toBeUndefined();
  });

  it('加载临时 .env 且不覆盖已存在的变量', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env');
    fs.writeFileSync(file, 'A_SIMPLE=from-file\nF_PRESET=from-file\n');
    process.env.F_PRESET = 'from-shell';
    const savedVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      loadDotEnv([file]);
    } finally {
      if (savedVitest !== undefined) process.env.VITEST = savedVitest;
    }
    expect(process.env.A_SIMPLE).toBe('from-file');
    expect(process.env.F_PRESET).toBe('from-shell'); // shell/Docker 注入的优先
  });

  it('文件不存在时静默跳过', () => {
    const savedVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => loadDotEnv([path.join(os.tmpdir(), 'env-nonexistent-zzz', '.env')])).not.toThrow();
    } finally {
      if (savedVitest !== undefined) process.env.VITEST = savedVitest;
    }
    expect(process.env.A_SIMPLE).toBeUndefined();
  });
});
