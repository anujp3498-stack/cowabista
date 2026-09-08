// Rocket Campaign roadmap requirement: "observability" -- /api/healthz must
// actually reflect whether the API can serve real requests, not just that
// the Node process is alive. A fake pool (instead of the real database)
// lets the failure branch be asserted deterministically without needing
// the actual database connection to be down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDatabaseHealth } from "../src/lib/database-health";

test("reports ok when the database round-trip succeeds", async () => {
  const pool = { query: async () => ({ rows: [{ "?column?": 1 }] }) };
  assert.equal(await checkDatabaseHealth(pool), "ok");
});

test("reports error (never throws) when the database round-trip rejects", async () => {
  const pool = { query: async () => { throw new Error("connection refused"); } };
  assert.equal(await checkDatabaseHealth(pool), "error");
});

test("passes a bounded query_timeout so a hung connection cannot hang the health check forever", async () => {
  let observedTimeout: number | undefined;
  const pool = {
    query: async (config: { text: string; query_timeout: number }) => {
      observedTimeout = config.query_timeout;
      return {};
    },
  };
  await checkDatabaseHealth(pool);
  assert.equal(typeof observedTimeout, "number");
  assert.ok(observedTimeout! > 0 && observedTimeout! <= 5_000, "timeout should be a small bounded value");
});
