// Database safety guard for every schema-changing command in this package (push.mjs, apply-sql.mjs,
// reset-disposable-local.mjs). Nothing here is used by the application at runtime.
//
// Two modes:
//
// - "disposable-local" (normal schema work): requires WABISTA_DB_TARGET=disposable-local and a database
//   that is NOT the production database (cowabista), NOT a benchmark database (any name containing
//   "bench"), NOT Host S, and on a loopback host unless the host is listed in WABISTA_DB_APPROVED_DEV_HOSTS.
//   After connecting it re-checks the server's own view (current_database(), inet_server_addr()) and
//   requires the database comment written by reset-disposable-local.mjs, which catches a tunnel or proxy
//   that makes a real database look local.
//
// - "benchmark" (`push-force` only): the established Gate B benchmark flow (benchmark/run.mjs,
//   benchmark/distributed/prepare.sh). DATABASE_URL must equal CAMPAIGN_BENCHMARK_DATABASE_URL, the
//   database name must have a bench/benchmark segment (run.mjs's rule), CAMPAIGN_BENCHMARK_CONFIRM must
//   equal that name, and it is never cowabista. The host is not restricted, because the benchmark database
//   lives on the shared PostgreSQL host; the name, the confirmation and the connected current_database() are
//   the protection. This mode cannot reach a non-benchmark database, so it cannot be used for migrations.
//
// Both modes refuse NODE_ENV=production, libpq service/hostaddr indirection, multi-host URLs and URL query
// parameters that could redirect the connection. Refusals exit with code 2 and never print a password.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import pg from "pg";

export const MODES = Object.freeze({ disposable: "disposable-local", benchmark: "benchmark" });
export const DISPOSABLE_TARGET = "disposable-local";
export const DISPOSABLE_MARKER = "wabista:disposable-local";

// Host S (the shared production PostgreSQL/Redis host) by name and private address.
export const BUILTIN_DENY_HOSTS = Object.freeze(["host-s", "10.0.0.4"]);
// Never a schema target in disposable mode. postgres/template* are server maintenance databases.
export const BUILTIN_DENY_NAMES = Object.freeze(["cowabista", "campaign_benchmark", "postgres", "template0", "template1"]);
// Same rule as artifacts/api-server/benchmark/run.mjs.
export const BENCH_SEGMENT = /(^|[_-])(bench|benchmark)([_-]|$)/i;

// Query parameters node-postgres copies into its connection config. Anything else (host, port, user,
// options, ...) could point the connection somewhere other than the URL's visible host and database.
const ALLOWED_URL_PARAMS = new Set(["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "application_name", "connect_timeout"]);
const REFUSED_PG_ENV = ["PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR"];

export class DatabaseGuardRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseGuardRefusal";
  }
}

function refuse(message) {
  throw new DatabaseGuardRefusal(message);
}

function listFromEnv(value) {
  return (value ?? "")
    .split(",")
    .map((item) => normalizeHost(item))
    .filter(Boolean);
}

function normalizeHost(host) {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackAddress(address) {
  const value = normalizeHost(address);
  if (isIP(value) === 4) return value.startsWith("127.");
  if (isIP(value) === 6) return value === "::1" || /^::ffff:127\./.test(value);
  return false;
}

/** sha256 of the exact DATABASE_URL, bound to the mode; drizzle.config.ts accepts only this value. */
export function guardStamp(mode, databaseUrl) {
  return `${mode}:${createHash("sha256").update(databaseUrl).digest("hex")}`;
}

/** Parses DATABASE_URL strictly. The result carries no password; `redacted` is safe to print. */
export function parseDatabaseUrl(raw) {
  if (!raw) refuse("DATABASE_URL is not set");
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPart.includes(",")) refuse("multi-host DATABASE_URL values are refused");
  let url;
  try {
    url = new URL(raw);
  } catch {
    refuse("DATABASE_URL is not a valid postgresql:// URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    refuse(`DATABASE_URL must use postgresql:// (got ${url.protocol})`);
  }
  const host = normalizeHost(decodeURIComponent(url.hostname));
  if (!host || host.startsWith("/") || host.startsWith("%2f")) {
    refuse("DATABASE_URL must name a TCP host explicitly (Unix-socket and default-host URLs are refused)");
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_URL_PARAMS.has(key)) refuse(`DATABASE_URL query parameter "${key}" is refused (it can redirect the connection)`);
  }
  const path = url.pathname.replace(/^\//, "");
  if (!path || path.includes("/")) refuse("DATABASE_URL must name exactly one database in its path");
  const database = decodeURIComponent(path);
  const port = url.port ? Number(url.port) : 5432;
  const user = decodeURIComponent(url.username);
  return { host, port, database, user, redacted: `${user ? `${user}@` : ""}${host}:${port}/${database}` };
}

async function defaultResolveHost(host) {
  if (isIP(host)) return [host];
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Every check that can run without connecting. Returns the parsed target, plus what the post-connect
 * check needs. `resolveHost` is injectable for tests. `allowApprovedHosts: false` makes the loopback
 * rule absolute (reset-disposable-local.mjs).
 */
export async function checkTargetBeforeConnect({
  mode,
  env = process.env,
  resolveHost = defaultResolveHost,
  allowApprovedHosts = true,
}) {
  if (mode !== MODES.disposable && mode !== MODES.benchmark) refuse(`unknown guard mode "${mode}"`);

  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    refuse("NODE_ENV=production: schema commands never run in production mode");
  }
  for (const name of REFUSED_PG_ENV) {
    if (env[name]) refuse(`${name} is set: libpq service and hostaddr indirection are refused`);
  }
  if (mode === MODES.disposable && env.WABISTA_DB_TARGET !== DISPOSABLE_TARGET) {
    refuse(`WABISTA_DB_TARGET must be "${DISPOSABLE_TARGET}" for schema work (see docs/DEVELOPMENT.md)`);
  }

  const databaseUrl = env.DATABASE_URL;
  const target = parseDatabaseUrl(databaseUrl);
  const name = target.database.toLowerCase();
  const extraDenyNames = (env.WABISTA_DB_DENY_NAMES ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (name === "cowabista") refuse(`database "${target.database}" is the production database`);
  if (extraDenyNames.includes(name)) refuse(`database "${target.database}" is listed in WABISTA_DB_DENY_NAMES`);

  if (mode === MODES.disposable) {
    if (BUILTIN_DENY_NAMES.includes(name) || name.startsWith("template")) {
      refuse(`database "${target.database}" is never a disposable schema target`);
    }
    if (name.includes("bench")) {
      refuse(`database "${target.database}" looks like a benchmark database; only push-force in the benchmark flow may touch it`);
    }
  } else {
    if (!env.CAMPAIGN_BENCHMARK_DATABASE_URL || env.CAMPAIGN_BENCHMARK_DATABASE_URL !== databaseUrl) {
      refuse("push-force is only for the benchmark flow: DATABASE_URL must equal CAMPAIGN_BENCHMARK_DATABASE_URL");
    }
    if (!BENCH_SEGMENT.test(target.database)) {
      refuse(`database "${target.database}" has no bench/benchmark name segment; push-force never targets other databases`);
    }
    if (env.CAMPAIGN_BENCHMARK_CONFIRM !== target.database) {
      refuse(`set CAMPAIGN_BENCHMARK_CONFIRM to the benchmark database name to confirm it`);
    }
  }

  // Host S is denied by name and address in disposable mode; operator deny entries apply in both modes.
  const denyHosts = new Set([
    ...(mode === MODES.disposable ? BUILTIN_DENY_HOSTS : []),
    ...listFromEnv(env.WABISTA_DB_DENY_HOSTS),
  ]);
  if (denyHosts.has(target.host)) refuse(`host "${target.host}" is denied (Host S or WABISTA_DB_DENY_HOSTS)`);

  let addresses;
  try {
    addresses = (await resolveHost(target.host)).map(normalizeHost);
  } catch {
    refuse(`host "${target.host}" does not resolve`);
  }
  if (!addresses.length) refuse(`host "${target.host}" does not resolve`);

  const denyAddresses = new Set();
  for (const entry of denyHosts) {
    if (isIP(entry)) {
      denyAddresses.add(entry);
      continue;
    }
    try {
      for (const address of await resolveHost(entry)) denyAddresses.add(normalizeHost(address));
    } catch {
      // A deny entry that does not resolve cannot be the target; the name check above still applies.
    }
  }
  const denied = addresses.find((address) => denyAddresses.has(address));
  if (denied) refuse(`host "${target.host}" resolves to denied address ${denied}`);

  const approvedHost = mode === MODES.disposable && allowApprovedHosts && listFromEnv(env.WABISTA_DB_APPROVED_DEV_HOSTS).includes(target.host);
  if (mode === MODES.disposable && !approvedHost && !addresses.every(isLoopbackAddress)) {
    refuse(
      allowApprovedHosts
        ? `host "${target.host}" is not loopback; list it in WABISTA_DB_APPROVED_DEV_HOSTS only if it is an approved development host`
        : `host "${target.host}" is not loopback; this command only works on a local server`,
    );
  }

  return { ...target, mode, databaseUrl, approvedHost, denyAddresses };
}

/** Re-checks the target from the server's side, on an open connection to the target database. */
export async function verifyConnectedDatabase(client, target, { requireMarker = target.mode === MODES.disposable } = {}) {
  const { rows } = await client.query(
    `select current_database() as database,
            host(inet_server_addr()) as server_address,
            inet_server_port() as server_port,
            shobj_description(d.oid, 'pg_database') as marker
       from pg_database d
      where d.datname = current_database()`,
  );
  const row = rows[0];
  if (!row) refuse("could not read the connected database's identity");
  if (row.database !== target.database) {
    refuse(`connected to database "${row.database}", expected "${target.database}" (a proxy or pooler is rewriting the target)`);
  }
  verifyServerAddress(row.server_address, target);
  if (requireMarker && row.marker !== DISPOSABLE_MARKER) {
    refuse(
      `database "${target.database}" is not marked disposable; create it with ` +
        "`pnpm --filter @workspace/db run reset-disposable-local` (local server only)",
    );
  }
  return row;
}

export function verifyServerAddress(serverAddress, target) {
  if (serverAddress == null) return; // Unix socket: the server is on this machine.
  const address = normalizeHost(serverAddress);
  if (target.denyAddresses.has(address)) refuse(`the server reports address ${address}, which is denied`);
  if (target.mode === MODES.disposable && !target.approvedHost && !isLoopbackAddress(address)) {
    refuse(`the server reports non-loopback address ${address}`);
  }
}

export function connect(connectionString) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, application_name: "wabista-db-guard" });
  return client.connect().then(() => client);
}

/**
 * Runs every check for `mode` against process.env and returns the verified target with its open client
 * (the caller ends it).
 */
export async function assertSafeDatabase({ mode, env = process.env }) {
  const target = await checkTargetBeforeConnect({ mode, env });
  const client = await connect(target.databaseUrl);
  try {
    await verifyConnectedDatabase(client, target);
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  console.log(`[db-guard] OK mode=${mode} target=${target.redacted}`);
  return { target, client };
}

/** CLI wrapper: a refusal exits 2 with a one-line reason, any other failure exits 1 without a stack of secrets. */
export async function runGuarded(main) {
  try {
    const code = await main();
    process.exitCode = code ?? 0;
  } catch (error) {
    if (error instanceof DatabaseGuardRefusal) {
      console.error(`[db-guard] REFUSED: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`[db-guard] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
