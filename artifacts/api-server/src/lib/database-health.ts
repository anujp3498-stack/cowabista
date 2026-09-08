/** Minimal shape this needs from `pg.Pool` -- kept narrow so a test double doesn't need a real Pool. */
type Pingable = { query(config: { text: string; query_timeout: number }): Promise<unknown> };

/**
 * A liveness-only "the process is up" health check stays green even while
 * the API is actually unable to serve any real request (e.g. the database
 * is unreachable), which defeats the point of a health check for an
 * orchestrator/monitor deciding whether to route traffic here or restart
 * the process. This does a real, bounded round-trip against the database.
 * Extracted from the route handler (rather than inlined) so the failure
 * branch is unit-testable with a fake pool instead of requiring the real
 * database connection to actually be down.
 */
export async function checkDatabaseHealth(pool: Pingable): Promise<"ok" | "error"> {
  try {
    await pool.query({ text: "select 1", query_timeout: 2_000 });
    return "ok";
  } catch {
    return "error";
  }
}
