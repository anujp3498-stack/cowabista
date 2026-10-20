import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

// The SPA calls the API with relative /api/... URLs, so the browser must see the SPA and the API on ONE
// origin. In production a reverse proxy serves the SPA at / and the API at /api
// (deploy/nginx/wabista.conf.example). In development `vite` (and `vite preview`) does the same: the SPA is
// served on WEB_PORT and /api is proxied to API_PROXY_TARGET. The shared PORT variable belongs to the API
// server and is deliberately not read here, so one .env can hold both. See docs/DEVELOPMENT.md.
//
// Environment: the repository-root .env files (envDir below) plus the shell, the shell winning. Only
// VITE_-prefixed values ever reach the browser bundle (Vite's own rule).

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function readPort(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${name} value: "${raw}"`);
  }
  return port;
}

export default defineConfig(({ mode }) => {
  const env: Record<string, string | undefined> = { ...loadEnv(mode, repoRoot, ''), ...process.env };

  const port = readPort(env, 'WEB_PORT', 24902);

  const basePath = env.BASE_PATH || '/';
  if (!basePath.startsWith('/')) {
    throw new Error(`Invalid BASE_PATH value: "${basePath}" (it must start with "/")`);
  }

  const apiProxyTarget = env.API_PROXY_TARGET || 'http://localhost:8080';
  try {
    const target = new URL(apiProxyTarget);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new Error(`Invalid API_PROXY_TARGET value: "${apiProxyTarget}" (expected an http(s) URL)`);
  }

  // A regular-expression key: Vite matches plain keys as string prefixes, and a plain '/api' would also
  // proxy the SPA route /api-developers.
  const proxy: Record<string, ProxyOptions> = {
    '^/api(?:/|\\?|$)': { target: apiProxyTarget, changeOrigin: false, xfwd: true },
  };

  // Vite's default host check accepts localhost and IP addresses. Set WEB_ALLOWED_HOSTS (comma-separated host
  // names) only when the dev server must answer another host name.
  const allowedHosts = env.WEB_ALLOWED_HOSTS?.split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    envDir: repoRoot,
    base: basePath,
    plugins: [react(), tailwindcss({ optimize: false })],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
      },
      dedupe: ['react', 'react-dom'],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, 'dist/public'),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts,
      proxy,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts,
      proxy,
    },
  };
});
