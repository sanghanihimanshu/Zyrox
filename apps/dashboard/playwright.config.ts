import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 4455;
export const WEB_PORT = 4173;
const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: `${resolve(root, 'packages/server/node_modules/.bin/tsx')} ${resolve(import.meta.dirname, 'e2e/server.ts')}`,
      url: `http://localhost:${PORT}/healthz`,
      reuseExistingServer: false,
      env: { PORT: String(PORT) },
    },
    {
      // The example web app, as a project's preview URL (its canvas route trusts this dashboard).
      command: `pnpm --filter @zyrox-examples/web build && pnpm --filter @zyrox-examples/web exec vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_ZYROX_DASHBOARD_ORIGINS: `http://localhost:${PORT}` },
    },
  ],
});
