// Shared by build.mjs and test/build-pino-relocatable.test.ts, so the test bundles pino exactly as the server build does.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import esbuildPluginPino from "esbuild-plugin-pino";

// Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
export const NODE_ESM_BANNER = `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `;

const TRANSPORTS = ["pino-pretty"];

// esbuild-plugin-pino emits pino's worker files next to the bundle, but with an absolute `outdir` it also writes that
// directory into the bundle as the place to load them from. The build output then differs per build directory, and a
// moved build (cutover W6 renames /opt/cowabista.next to /opt/cowabista) cannot start a pino transport. This plugin runs
// first and gives pino the same worker paths, resolved when the process starts, next to the running file
// (globalThis.__dirname, set by NODE_ESM_BANNER from import.meta.url). Its onLoad answers for pino.js, so
// esbuild-plugin-pino's own onLoad for that file never runs; that plugin still adds the worker entry points.
function pinoWorkersNextToBundle() {
  const pinoDir = path.dirname(createRequire(import.meta.url).resolve("pino"));
  // the same worker set, names and extension as esbuild-plugin-pino 2.3.3 emits for this build
  const ids = ["thread-stream-worker", "pino-worker", "pino-file"];
  if (existsSync(path.join(pinoDir, "lib/worker-pipeline.js"))) ids.push("pino-pipeline-worker");
  ids.push(...TRANSPORTS);
  const overrides = ids
    .map((id) => `${JSON.stringify(id === "pino-file" ? "pino/file" : id)}: __pinoWorkerFile(${JSON.stringify(`./${id}.mjs`)})`)
    .join(", ");
  const prelude = `function __pinoWorkerFile(file) { return require("path").join(globalThis.__dirname, file); }
globalThis.__bundlerPathsOverrides = { ...(globalThis.__bundlerPathsOverrides || {}), ${overrides} };
`;
  return {
    name: "pino-workers-next-to-bundle",
    setup(build) {
      build.onLoad({ filter: /[\\/]pino[\\/]pino\.js$/ }, async (args) => ({ contents: prelude + (await readFile(args.path, "utf8")) }));
    },
  };
}

// pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
export function pinoPlugins() {
  return [pinoWorkersNextToBundle(), esbuildPluginPino({ transports: TRANSPORTS })];
}
