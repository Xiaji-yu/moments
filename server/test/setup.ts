import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 每个测试文件独立临时 DATA_DIR。
 * 必须在任何模块 import db.ts 之前设置（config.ts 在模块加载时读取环境变量）。
 * 配合 pool: 'forks'（每个测试文件独立进程），保证测试间数据完全隔离。
 */
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-test-'));
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
