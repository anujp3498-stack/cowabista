import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryName = process.argv[2] ?? "campaign-rate-limit.test.ts";
if (!/^[a-z0-9-]+\.test\.ts$/.test(entryName)) throw new Error("Invalid test entry name");
const output = path.join(artifactDir, ".test-dist", entryName.replace(/\.ts$/, ".mjs"));

await rm(path.dirname(output), { recursive: true, force: true });
await build({
  entryPoints: [path.join(artifactDir, "test", entryName)],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  // "esbuild" must stay external: campaign-worker-os-crash-recovery.test.ts
  // imports esbuild itself (to build its own OS-process harness), and
  // esbuild's package internals rely on CJS-style `__filename` to locate its
  // native binary -- inlining it into this file's own ESM bundle breaks that
  // lookup with "ReferenceError: __filename is not defined", even though the
  // banner's require shim covers everything else in this bundle.
  external: ["pg-native", "pino", "pino-pretty", "thread-stream", "esbuild"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);",
  },
});
await build({
  entryPoints: [path.join(artifactDir, "src/services/campaign-transport-shard-worker.ts")],
  outfile: path.join(path.dirname(output), "campaign-transport-shard-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
});

const child = spawn(process.execPath, ["--test", output], {
  cwd: artifactDir,
  env: process.env,
  stdio: "inherit",
});
child.on("exit", async (code, signal) => {
  await rm(path.dirname(output), { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});