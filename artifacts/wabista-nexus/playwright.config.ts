import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The SPA calls the API with relative /api/* URLs, so the browser must reach the SPA and the API on ONE
// origin. Locally that origin is the Vite dev server (WEB_PORT, default 24902), which proxies /api to the
// API server; the web server started below gets API_PROXY_TARGET=http://localhost:<PORT> (PORT default 8080)
// so the two always agree. Hitting the API port
// directly, or a web server without that proxy, makes relative /api fetches fall through to the SPA's HTML.
//
// - E2E_BASE_URL unset (default): Playwright starts the API and the web dev server itself, reusing ones that
//   are already listening, and drives http://localhost:<WEB_PORT>. The API reads its configuration from the
//   repository .env (see docs/DEVELOPMENT.md); point DATABASE_URL at a disposable local database only.
// - E2E_BASE_URL set: Playwright starts nothing and drives that already-running deployment (for example a
//   dedicated test server behind the reverse proxy in deploy/nginx/wabista.conf.example).
//
// PLAYWRIGHT_CHROMIUM_EXECUTABLE optionally points at a Chromium binary; otherwise Playwright's own browser
// (installed with `pnpm --filter @workspace/wabista-nexus exec playwright install --with-deps chromium`) is used.

// The test process (the specs) reads the same repository-root .env as the dev servers; variables
// already set in the shell win.
const repoEnvFile = path.resolve(import.meta.dirname, '..', '..', '.env');
if (existsSync(repoEnvFile)) process.loadEnvFile(repoEnvFile);

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid ${name} value: "${raw}"`);
  return port;
}

const externalBaseURL = process.env.E2E_BASE_URL?.trim() || undefined;
const webPort = readPort('WEB_PORT', 24902);
const apiPort = readPort('PORT', 8080);
const baseURL = externalBaseURL ?? `http://localhost:${webPort}`;
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim() || undefined;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : [
        {
          command: 'pnpm --filter @workspace/api-server run dev',
          url: `http://localhost:${apiPort}/api/healthz`,
          env: { PORT: String(apiPort) },
          reuseExistingServer: true,
          timeout: 180_000,
        },
        {
          command: 'pnpm --filter @workspace/wabista-nexus run dev',
          url: `http://localhost:${webPort}/`,
          env: { WEB_PORT: String(webPort), API_PROXY_TARGET: `http://localhost:${apiPort}` },
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ],
});
