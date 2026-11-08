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
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      GOOGLE_AUTH_URL: 'http://127.0.0.1:2527/auth',
      GOOGLE_TOKEN_URL: 'http://127.0.0.1:2527/token',
      GOOGLE_USERINFO_URL: 'http://127.0.0.1:2527/userinfo',
      STORAGE: 'local',
      SMTP_URL: 'smtp://127.0.0.1:2526',
      STORAGE_DIR: '.test-uploads',
    },
  },
});
