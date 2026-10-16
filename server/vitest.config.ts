import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 每个测试文件独立子进程：db.ts 是模块级 SQLite 单例，需要进程级隔离
    pool: 'forks',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
