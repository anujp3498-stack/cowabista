import { defineConfig, devices } from '@playwright/test'

const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim()

// Independent frontend-only browser smoke. Deliberately never boots the API.
// No production URL or DATABASE_URL is used. Intercepted localhost requests
// simulate an owner/admin and the EXISTING template-sync API.
export default defineConfig({
  testDir: './test/inline-sync-browser',
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  projects: [{ name: 'chromium', use: {
    ...devices['Desktop Chrome'],
    ...(browserExecutable ? { launchOptions: { executablePath: browserExecutable } } : {}),
  } }],
  use: {
    baseURL: 'http://127.0.0.1:24983',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm run dev',
    url: 'http://127.0.0.1:24983/test/inline-sync-browser/harness.html',
    env: {
      WEB_PORT: '24983',
      API_PROXY_TARGET: 'http://127.0.0.1:1',
    },
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
