#!/usr/bin/env node
// Guarded `drizzle-kit push`. The only supported way to push the schema (drizzle.config.ts refuses to run
// without the stamp this script sets).
//
//   pnpm --filter @workspace/db run push         disposable-local mode: WABISTA_DB_TARGET=disposable-local,
//                                                a local database marked by reset-disposable-local.mjs.
//                                                No --force: drizzle-kit aborts instead of losing data.
//   pnpm --filter @workspace/db run push-force   benchmark mode only (benchmark/run.mjs and
//                                                benchmark/distributed/prepare.sh); never for migrations.
//
// Before pushing it creates the extensions the schema needs: drizzle-kit has no CREATE EXTENSION, and the
// GIN trigram indexes (gin_trgm_ops) fail on a fresh database without pg_trgm. See assert-safe-database.mjs.
import { spawnSync } from "node:child_process";
import { devNull } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeDatabase, DatabaseGuardRefusal, guardStamp, MODES, runGuarded } from "./assert-safe-database.mjs";

const REQUIRED_EXTENSIONS = ["pg_trgm"];
const PASSTHROUGH = ["--verbose", "--strict"];
const libDbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await runGuarded(async () => {
  // `pnpm run push -- --verbose` passes the "--" separator through. --verbose and --strict are drizzle-kit's
  // own (print the statements; ask before applying), never --force.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => !["--benchmark-force", ...PASSTHROUGH].includes(arg));
  if (unknown.length) {
    throw new DatabaseGuardRefusal(`unknown argument ${unknown[0]} (usage: push.mjs [--benchmark-force] [--verbose] [--strict])`);
  }
  const mode = args.includes("--benchmark-force") ? MODES.benchmark : MODES.disposable;

  const { target, client } = await assertSafeDatabase({ mode });
  try {
    for (const extension of REQUIRED_EXTENSIONS) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
      console.log(`[db-guard] ${extension} is enabled`);
    }
  } finally {
    await client.end();
  }

  const drizzleArgs = [
    "push",
    ...(mode === MODES.benchmark ? ["--force"] : []),
    ...args.filter((arg) => PASSTHROUGH.includes(arg)),
    "--config",
    "./drizzle.config.ts",
  ];
  // drizzle-kit gets the URL the guard checked, with its port written out, and must not load a .env of its
  // own: it runs dotenv/config, which would otherwise read lib/db/.env (or DOTENV_CONFIG_PATH) and could
  // add a PG* variable after the check.
  const env = {
    ...process.env,
    DATABASE_URL: target.connectionUrl,
    WABISTA_DB_GUARD_STAMP: guardStamp(mode, target.connectionUrl),
    DOTENV_CONFIG_PATH: devNull,
  };
  delete env.DOTENV_CONFIG_OVERRIDE;
  // drizzle-kit resolves its config under TEST_CONFIG_PATH_PREFIX when set, which would skip drizzle.config.ts.
  delete env.TEST_CONFIG_PATH_PREFIX;
  const result = spawnSync(path.join(libDbDir, "node_modules", ".bin", "drizzle-kit"), drizzleArgs, {
    cwd: libDbDir,
    stdio: "inherit",
    env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
});
