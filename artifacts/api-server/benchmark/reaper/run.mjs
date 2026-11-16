// Bundles and runs the reaper backlog study (benchmark/reaper/backlog.ts). Not a Gate B measured file.
// Usage (from artifacts/api-server): node benchmark/reaper/run.mjs --label <name> [backlog.ts options]
// Env: REAPER_STUDY_DATABASE_URL (a disposable local database whose name contains "reaper_study").
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.resolve(here, "..", "..");
const label = process.argv[process.argv.indexOf("--label") + 1];
if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("--label <name> is required");
const url = process.env.REAPER_STUDY_DATABASE_URL;
if (!url || !/reaper_study/.test(new URL(url).pathname)) throw new Error("REAPER_STUDY_DATABASE_URL must name a reaper_study database");
const out = path.join(api, "benchmark-results", "reaper", label);
mkdirSync(out, { recursive: true });
const bundle = path.join(out, "backlog.mjs");
await build({
  entryPoints: [path.join(here, "backlog.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", sourcemap: "inline",
  external: ["pg-native", "pino", "pino-pretty", "thread-stream"], logLevel: "error",
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
});
const child = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, DATABASE_URL: url, REAPER_STUDY_OUT: path.join(out, "result.json"), LOG_LEVEL: "warn" },
});
process.exit(child.status ?? 1);
