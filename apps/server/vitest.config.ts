import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://opensheet:opensheet@localhost:5432/opensheet_test',
      APP_URL: 'http://localhost:5173',
      NODE_ENV: 'test',
    },
  },
});
