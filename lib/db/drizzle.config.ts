import { createHash } from "node:crypto";
import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// drizzle-kit is only ever run by scripts/push.mjs, after scripts/assert-safe-database.mjs has checked the
// target. push.mjs passes a stamp bound to the exact DATABASE_URL and its mode; anything else (a bare
// `drizzle-kit push`, `npx drizzle-kit ...`, another URL) is refused here before any connection is made.
// --force is accepted only in benchmark mode (push-force), never for schema work on other databases.
const urlHash = createHash("sha256").update(process.env.DATABASE_URL).digest("hex");
const stamp = process.env.WABISTA_DB_GUARD_STAMP;
const mode =
  stamp === `disposable-local:${urlHash}` ? "disposable-local" : stamp === `benchmark:${urlHash}` ? "benchmark" : undefined;
if (!mode) {
  throw new Error(
    "Refusing to run drizzle-kit outside the database guard: use `pnpm --filter @workspace/db run push` " +
      "(WABISTA_DB_TARGET=disposable-local, a local disposable database; see docs/DEVELOPMENT.md)",
  );
}
if (mode !== "benchmark" && process.argv.includes("--force")) {
  throw new Error("Refusing drizzle-kit --force outside the benchmark flow (push-force)");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
