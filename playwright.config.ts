import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';

const apiDataDir = path.join(tmpdir(), 'moments-e2e-data');

export default defineConfig({
  testDir: './e2e/tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `rm -rf ${apiDataDir} && npm run dev:server`,
      port: 8787,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATA_DIR: apiDataDir,
        JWT_SECRET: 'e2e-secret',
        REGISTER_ENABLED: 'true',
        // E2E 多个用例共享 localhost 同一 IP，路由级限速会把初始化/轮询请求打满；
        // 限速行为由 server/test/integration/auth.rate-limit.test.ts 专项覆盖
        RATE_LIMIT_ENABLED: 'false',
      },
    },
    {
      command: 'npm run dev:web',
      port: 5173,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
