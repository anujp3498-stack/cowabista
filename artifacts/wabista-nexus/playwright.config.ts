import { defineConfig, devices } from '@playwright/test';

// wabista-nexus (port 24902) and api-server (port 8080, path /api) are two
// separate services multiplexed by Replit's shared reverse proxy under one
// origin. Hitting the Vite dev server directly on localhost:24902 bypasses
// that proxy, so a relative fetch to /api/* 404s into Vite's SPA fallback
// (HTML, not JSON) instead of reaching the API server. Always drive the
// browser through the proxied dev domain, exactly like a real user would.
if (!process.env.REPLIT_DEV_DOMAIN) {
  throw new Error('REPLIT_DEV_DOMAIN is required to run this suite through the shared reverse proxy.');
}
const baseURL = `https://${process.env.REPLIT_DEV_DOMAIN}`;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './test/e2e/global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
