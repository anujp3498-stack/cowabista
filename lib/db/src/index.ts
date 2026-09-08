import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const poolOptions = {
  connectionString: process.env.DATABASE_URL,
  // Bounds worst-case connection usage under the campaign-runtime's
  // concurrent job/lease/audit queries plus normal request traffic, instead
  // of letting pg's default (unbounded per-process) grow unchecked under
  // load. connectionTimeoutMillis fails fast (instead of hanging a request
  // indefinitely) when the pool is saturated; idleTimeoutMillis recycles
  // connections the API server isn't actively using.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
} satisfies ConstructorParameters<typeof Pool>[0];

export const pool = new Pool({
  ...poolOptions,
  max: 20,
});

/**
 * Settlement writes are deliberately isolated from the claim/supply pool.
 * Provider completion can be slow or briefly deadlock behind campaign rows;
 * it must not consume every connection needed to refill ready work.
 */
export const settlementPool = new Pool({
  ...poolOptions,
  max: 6,
});
// A pooled client can emit a background 'error' event (e.g. the database
// terminates an idle connection) outside of any query call site. pg's Pool
// is an EventEmitter, and Node kills the process on an EventEmitter 'error'
// with no listener -- so leaving this unhandled turns a single recoverable
// connection drop into a full API server crash. The pool itself removes and
// replaces the bad client; this handler only needs to log, not react.
pool.on("error", (error) => {
  // eslint-disable-next-line no-console -- lib/db has no app logger; the
  // owning process's own logger/crash handlers pick this up from stderr.
  console.error("[db] idle client error", error);
});
settlementPool.on("error", (error) => {
  // eslint-disable-next-line no-console -- see the primary pool handler above.
  console.error("[db] settlement idle client error", error);
});
export const db = drizzle(pool, { schema });
export const settlementDb = drizzle(settlementPool, { schema });

export * from "./schema";
