// The server bundle must not depend on the directory it was built in. Cutover W6 builds in /opt/cowabista.next and
// renames the tree to /opt/cowabista, and operators compare artifact hashes across hosts and paths. pino starts its
// transport through worker files emitted next to the bundle (thread-stream worker, pino worker, pino/file,
// pino-pretty); this test bundles pino with the server build's own plugins and banner (build-pino.mjs), in two
// directories, then moves one build and runs it with a pino-pretty transport (the non-production logger).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { NODE_ESM_BANNER, pinoPlugins } from "../build-pino.mjs";

// esbuild-plugin-pino resolves pino through the global `require`, as build.mjs provides it
(globalThis as { require?: NodeJS.Require }).require = createRequire(import.meta.url);

const apiServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "pino-relocatable-"));
after(() => rmSync(root, { recursive: true, force: true }));

const PROBE = `import pino from "pino";
const logger = pino({ transport: { target: "pino-pretty", options: { colorize: false } } });
logger.info("relocation-probe-line");
`;

// Two sibling trees at the same depth, so paths relative to the working directory are identical in both builds.
async function buildTree(name: string): Promise<string> {
  const tree = path.join(root, name);
  mkdirSync(path.join(tree, "src"), { recursive: true });
  writeFileSync(path.join(tree, "src", "probe.ts"), PROBE);
  await build({
    absWorkingDir: tree,
    entryPoints: [path.join(tree, "src", "probe.ts")],
    nodePaths: [path.join(apiServerDir, "node_modules")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: path.join(tree, "dist"),
    outExtension: { ".js": ".mjs" },
    sourcemap: "linked",
    logLevel: "silent",
    plugins: pinoPlugins(),
    banner: { js: NODE_ESM_BANNER },
  });
  return tree;
}

let treeA = "";
let treeB = "";
before(async () => {
  treeA = await buildTree("build-a");
  treeB = await buildTree("build-b");
});

test("the bundle embeds no absolute build directory", () => {
  for (const file of readdirSync(path.join(treeA, "dist"))) {
    const text = readFileSync(path.join(treeA, "dist", file), "utf8");
    assert.equal(text.includes(treeA), false, `${file} contains the build directory ${treeA}`);
  }
});

test("builds in two directories are byte-identical", () => {
  const files = readdirSync(path.join(treeA, "dist")).sort();
  assert.deepEqual(readdirSync(path.join(treeB, "dist")).sort(), files);
  assert.ok(files.includes("probe.mjs") && files.includes("thread-stream-worker.mjs") && files.includes("pino-pretty.mjs"), files.join(" "));
  for (const file of files) {
    assert.ok(readFileSync(path.join(treeA, "dist", file)).equals(readFileSync(path.join(treeB, "dist", file))), `${file} differs between build directories`);
  }
});

test("a moved build still starts its pino transport worker and logs", () => {
  const moved = path.join(root, "moved-elsewhere");
  renameSync(treeA, moved);
  const env = { ...process.env };
  delete env.NODE_ENV;
  const result = spawnSync(process.execPath, [path.join(moved, "dist", "probe.mjs")], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(output, /Cannot find module/, output);
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /relocation-probe-line/, output);
});
