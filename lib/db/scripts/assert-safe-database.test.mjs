// Unit tests for the database guard. No database is needed: host resolution is injected, the post-connect
// checks get a fake client, and the CLI cases stop at a pre-connect refusal (or never connect at all).
//
//   pnpm --filter @workspace/db run test:guard
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkTargetBeforeConnect,
  DatabaseGuardRefusal,
  DISPOSABLE_MARKER,
  guardStamp,
  MODES,
  parseDatabaseUrl,
  verifyConnectedDatabase,
} from "./assert-safe-database.mjs";
import { checkAdditiveSql } from "./apply-sql.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const libDbDir = path.resolve(scriptsDir, "..");

const HOSTS = {
  localhost: ["127.0.0.1", "::1"],
  "host-s": ["10.0.0.4"],
  "db.internal": ["10.0.0.4"],
  "devbox.lan": ["192.168.1.20"],
  "pg.example.com": ["203.0.113.7"],
  "cell-db": ["10.0.0.9"],
};
async function resolveHost(host) {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return [host];
  const addresses = HOSTS[host];
  if (!addresses) throw new Error("ENOTFOUND");
  return addresses;
}

const DEV_URL = "postgresql://dev:secret-pw@localhost:5432/wabista_dev";
const devEnv = (overrides = {}) => ({ WABISTA_DB_TARGET: "disposable-local", DATABASE_URL: DEV_URL, ...overrides });
const benchEnv = (url, overrides = {}) => ({
  DATABASE_URL: url,
  CAMPAIGN_BENCHMARK_DATABASE_URL: url,
  CAMPAIGN_BENCHMARK_CONFIRM: new URL(url).pathname.slice(1),
  ...overrides,
});

async function refusal(mode, env, pattern, options = {}) {
  await assert.rejects(
    checkTargetBeforeConnect({ mode, env, resolveHost, ...options }),
    (error) => {
      assert.ok(error instanceof DatabaseGuardRefusal, `expected a refusal, got ${error}`);
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /secret-pw/);
      return true;
    },
  );
}

describe("disposable-local mode: accepted targets", () => {
  for (const url of [
    DEV_URL,
    "postgresql://dev:secret-pw@127.0.0.1:5432/wabista_dev",
    "postgres://dev@[::1]:5433/wabista_r1a_dev?sslmode=disable",
  ]) {
    test(url.replace("secret-pw", "***"), async () => {
      const target = await checkTargetBeforeConnect({ mode: MODES.disposable, env: devEnv({ DATABASE_URL: url }), resolveHost });
      assert.equal(target.mode, MODES.disposable);
      assert.doesNotMatch(target.redacted, /secret-pw/);
    });
  }

  test("an explicitly approved non-loopback development host", async () => {
    const env = devEnv({ DATABASE_URL: "postgresql://dev@devbox.lan/wabista_dev", WABISTA_DB_APPROVED_DEV_HOSTS: "devbox.lan" });
    const target = await checkTargetBeforeConnect({ mode: MODES.disposable, env, resolveHost });
    assert.equal(target.approvedHost, true);
  });
});

describe("disposable-local mode: refusals", () => {
  const cases = [
    ["WABISTA_DB_TARGET unset", { WABISTA_DB_TARGET: undefined }, /WABISTA_DB_TARGET must be "disposable-local"/],
    ["WABISTA_DB_TARGET wrong", { WABISTA_DB_TARGET: "production" }, /WABISTA_DB_TARGET must be "disposable-local"/],
    ["NODE_ENV=production", { NODE_ENV: "production" }, /NODE_ENV=production/],
    ["NODE_ENV=Production (case/space)", { NODE_ENV: " Production " }, /NODE_ENV=production/],
    ["DATABASE_URL unset", { DATABASE_URL: undefined }, /DATABASE_URL is not set/],
    ["production database cowabista", { DATABASE_URL: "postgresql://dev@localhost/cowabista" }, /production database/],
    ["production database, other case", { DATABASE_URL: "postgresql://dev@localhost/CoWabista" }, /production database/],
    ["campaign_benchmark", { DATABASE_URL: "postgresql://dev@localhost/campaign_benchmark" }, /never a disposable schema target/],
    ["a bench name", { DATABASE_URL: "postgresql://dev@localhost/wabista_bench" }, /looks like a benchmark database/],
    ["a benchmark name", { DATABASE_URL: "postgresql://dev@localhost/mybenchmarkcopy" }, /looks like a benchmark database/],
    ["bench in another case", { DATABASE_URL: "postgresql://dev@localhost/BenchDev" }, /looks like a benchmark database/],
    ["postgres maintenance db", { DATABASE_URL: "postgresql://dev@localhost/postgres" }, /never a disposable schema target/],
    ["template1", { DATABASE_URL: "postgresql://dev@localhost/template1" }, /never a disposable schema target/],
    ["template-like name", { DATABASE_URL: "postgresql://dev@localhost/template_dev" }, /never a disposable schema target/],
    ["WABISTA_DB_DENY_NAMES", { WABISTA_DB_DENY_NAMES: "other, wabista_dev" }, /WABISTA_DB_DENY_NAMES/],
    ["Host S by name", { DATABASE_URL: "postgresql://dev@host-s:5432/wabista_dev" }, /host "host-s" is denied/],
    ["Host S by name, upper case", { DATABASE_URL: "postgresql://dev@HOST-S:5432/wabista_dev" }, /host "host-s" is denied/],
    ["Host S by address", { DATABASE_URL: "postgresql://dev@10.0.0.4:5432/wabista_dev" }, /host "10.0.0.4" is denied/],
    ["a name resolving to Host S", { DATABASE_URL: "postgresql://dev@db.internal/wabista_dev" }, /resolves to denied address 10\.0\.0\.4/],
    [
      "Host S even when approved",
      { DATABASE_URL: "postgresql://dev@db.internal/wabista_dev", WABISTA_DB_APPROVED_DEV_HOSTS: "db.internal" },
      /resolves to denied address 10\.0\.0\.4/,
    ],
    [
      "WABISTA_DB_DENY_HOSTS",
      { DATABASE_URL: "postgresql://dev@devbox.lan/wabista_dev", WABISTA_DB_APPROVED_DEV_HOSTS: "devbox.lan", WABISTA_DB_DENY_HOSTS: "devbox.lan" },
      /is denied/,
    ],
    ["non-loopback host not approved", { DATABASE_URL: "postgresql://dev@pg.example.com/wabista_dev" }, /is not loopback/],
    ["non-loopback address not approved", { DATABASE_URL: "postgresql://dev@192.168.1.20/wabista_dev" }, /is not loopback/],
    ["unresolvable host", { DATABASE_URL: "postgresql://dev@nowhere.invalid/wabista_dev" }, /does not resolve/],
    ["PGSERVICE", { PGSERVICE: "prod" }, /PGSERVICE is set/],
    ["PGSERVICEFILE", { PGSERVICEFILE: "/etc/pg_service.conf" }, /PGSERVICEFILE is set/],
    ["PGHOSTADDR", { PGHOSTADDR: "10.0.0.4" }, /PGHOSTADDR is set/],
    ["service= parameter", { DATABASE_URL: `${DEV_URL}?service=prod` }, /query parameter "service" is refused/],
    ["host= parameter", { DATABASE_URL: `${DEV_URL}?host=host-s` }, /query parameter "host" is refused/],
    ["hostaddr= parameter", { DATABASE_URL: `${DEV_URL}?hostaddr=10.0.0.4` }, /query parameter "hostaddr" is refused/],
    ["port= parameter", { DATABASE_URL: `${DEV_URL}?sslmode=disable&port=6432` }, /query parameter "port" is refused/],
    ["an unencoded ? in a password is refused without printing it", { DATABASE_URL: "postgresql://dev:?S3cretPart@localhost:5432/wabista_dev" }, /query parameter \(not shown\) is refused/],
    ["multi-host URL", { DATABASE_URL: "postgresql://dev:secret-pw@localhost:5432,host-s:5432/wabista_dev" }, /multi-host/],
    ["Unix-socket URL", { DATABASE_URL: "postgresql://%2Fvar%2Frun%2Fpostgresql/wabista_dev" }, /TCP host explicitly/],
    ["default-host URL", { DATABASE_URL: "postgresql:///wabista_dev" }, /TCP host explicitly|valid postgresql/],
    ["no database", { DATABASE_URL: "postgresql://dev@localhost:5432/" }, /exactly one database/],
    ["not postgres", { DATABASE_URL: "mysql://dev@localhost/wabista_dev" }, /must use postgresql/],
    [
      "Host S as IPv4-mapped IPv6, even if approved",
      { DATABASE_URL: "postgresql://dev@[::ffff:10.0.0.4]:5432/wabista_dev", WABISTA_DB_APPROVED_DEV_HOSTS: "::ffff:a00:4" },
      /host "10\.0\.0\.4" is denied/,
    ],
    ["invalid percent-encoding", { DATABASE_URL: "postgresql://dev@localhost/%zz" }, /invalid percent-encoding/],
    ["encoded comma in the host", { DATABASE_URL: "postgresql://dev@localhost%2C10.0.0.4/wabista_dev" }, /host contains characters/],
    ["NUL in the database name", { DATABASE_URL: "postgresql://dev@localhost/cowabista%00" }, /database name contains characters/],
    ["invalid PGPORT", { DATABASE_URL: "postgresql://dev@localhost/wabista_dev", PGPORT: "65536" }, /PGPORT is not a valid port/],
  ];
  for (const [name, overrides, pattern] of cases) {
    test(name, () => refusal(MODES.disposable, devEnv(overrides), pattern));
  }

  test("reset-disposable-local ignores approvals: loopback only", () =>
    refusal(
      MODES.disposable,
      devEnv({ DATABASE_URL: "postgresql://dev@devbox.lan/wabista_dev", WABISTA_DB_APPROVED_DEV_HOSTS: "devbox.lan" }),
      /only works on a local server/,
      { allowApprovedHosts: false },
    ));
});

describe("benchmark mode (push-force)", () => {
  test("accepts the established Gate B target on the shared database host", async () => {
    const url = "postgresql://bench:secret-pw@10.0.0.4:5432/campaign_benchmark";
    const target = await checkTargetBeforeConnect({ mode: MODES.benchmark, env: benchEnv(url), resolveHost });
    assert.equal(target.database, "campaign_benchmark");
  });

  test("accepts a local bench database without WABISTA_DB_TARGET", async () => {
    const url = "postgresql://bench@127.0.0.1:5432/r1a_guard_bench";
    await checkTargetBeforeConnect({ mode: MODES.benchmark, env: benchEnv(url), resolveHost });
  });

  const url = "postgresql://bench:secret-pw@10.0.0.4:5432/campaign_benchmark";
  const cases = [
    ["CAMPAIGN_BENCHMARK_DATABASE_URL unset", benchEnv(url, { CAMPAIGN_BENCHMARK_DATABASE_URL: undefined }), /must equal CAMPAIGN_BENCHMARK_DATABASE_URL/],
    [
      "DATABASE_URL differs from the benchmark URL",
      benchEnv(url, { DATABASE_URL: "postgresql://dev@localhost/wabista_dev" }),
      /must equal CAMPAIGN_BENCHMARK_DATABASE_URL/,
    ],
    ["the production database", benchEnv("postgresql://cowabista@10.0.0.4:5432/cowabista"), /production database/],
    ["a development database", benchEnv("postgresql://dev@localhost/wabista_dev"), /no bench\/benchmark name segment/],
    ["bench without a segment", benchEnv("postgresql://dev@localhost/campaignbenchmark"), /no bench\/benchmark name segment/],
    ["confirmation missing", benchEnv(url, { CAMPAIGN_BENCHMARK_CONFIRM: undefined }), /CAMPAIGN_BENCHMARK_CONFIRM/],
    ["confirmation for another name", benchEnv(url, { CAMPAIGN_BENCHMARK_CONFIRM: "other_benchmark" }), /CAMPAIGN_BENCHMARK_CONFIRM/],
    ["NODE_ENV=production", benchEnv(url, { NODE_ENV: "production" }), /NODE_ENV=production/],
    ["WABISTA_DB_DENY_NAMES", benchEnv(url, { WABISTA_DB_DENY_NAMES: "campaign_benchmark" }), /WABISTA_DB_DENY_NAMES/],
    ["WABISTA_DB_DENY_HOSTS", benchEnv(url, { WABISTA_DB_DENY_HOSTS: "10.0.0.4" }), /is denied/],
    ["PGSERVICE", benchEnv(url, { PGSERVICE: "prod" }), /PGSERVICE is set/],
    ["host= parameter", benchEnv(`${url}?host=localhost`), /query parameter "host" is refused/],
  ];
  for (const [name, env, pattern] of cases) {
    test(name, () => refusal(MODES.benchmark, env, pattern));
  }
});

describe("post-connect identity checks", () => {
  const fakeClient = (row) => ({ query: async () => ({ rows: row ? [row] : [] }) });
  const disposableTarget = () => checkTargetBeforeConnect({ mode: MODES.disposable, env: devEnv(), resolveHost });
  const good = { database: "wabista_dev", server_address: "127.0.0.1", server_port: 5432, marker: DISPOSABLE_MARKER };

  test("a marked local database passes", async () => {
    await verifyConnectedDatabase(fakeClient(good), await disposableTarget());
    await verifyConnectedDatabase(fakeClient({ ...good, server_address: null }), await disposableTarget());
  });

  for (const [name, row, pattern] of [
    ["missing marker", { ...good, marker: null }, /not marked disposable/],
    ["another comment", { ...good, marker: "production" }, /not marked disposable/],
    ["a rewritten database name", { ...good, database: "cowabista" }, /connected to database "cowabista"/],
    ["the server is Host S (tunnel)", { ...good, server_address: "10.0.0.4" }, /denied/],
    ["a non-loopback server", { ...good, server_address: "192.168.1.20" }, /non-loopback address/],
    ["no identity row", null, /could not read/],
  ]) {
    test(name, async () => {
      await assert.rejects(verifyConnectedDatabase(fakeClient(row), await disposableTarget()), pattern);
    });
  }

  test("benchmark mode needs no marker but checks the name", async () => {
    const url = "postgresql://bench@10.0.0.4:5432/campaign_benchmark";
    const target = await checkTargetBeforeConnect({ mode: MODES.benchmark, env: benchEnv(url), resolveHost });
    const row = { database: "campaign_benchmark", server_address: "10.0.0.4", server_port: 5432, marker: null };
    await verifyConnectedDatabase(fakeClient(row), target);
    await assert.rejects(verifyConnectedDatabase(fakeClient({ ...row, database: "cowabista" }), target), /expected "campaign_benchmark"/);
  });

  test("the printable target never carries the password", () => {
    const { connectionUrl, ...printable } = parseDatabaseUrl("postgresql://dev:secret-pw@localhost:5433/wabista_dev", {});
    assert.deepEqual(printable, { host: "localhost", port: 5433, database: "wabista_dev", user: "dev", redacted: "dev@localhost:5433/wabista_dev" });
    assert.equal(connectionUrl, "postgresql://dev:secret-pw@localhost:5433/wabista_dev");
  });

  test("the connection URL writes out the effective port (URL, else PGPORT, else 5432)", () => {
    assert.equal(parseDatabaseUrl("postgresql://dev@localhost/wabista_dev", {}).connectionUrl, "postgresql://dev@localhost:5432/wabista_dev");
    const viaPgPort = parseDatabaseUrl("postgresql://dev@localhost/wabista_dev?sslmode=disable", { PGPORT: "6543" });
    assert.equal(viaPgPort.connectionUrl, "postgresql://dev@localhost:6543/wabista_dev?sslmode=disable");
    assert.equal(viaPgPort.redacted, "dev@localhost:6543/wabista_dev");
    assert.equal(parseDatabaseUrl("postgresql://dev@localhost:5433/wabista_dev", { PGPORT: "6543" }).port, 5433);
    assert.equal(parseDatabaseUrl("postgresql://dev@[::1]/wabista_dev", {}).connectionUrl, "postgresql://dev@[::1]:5432/wabista_dev");
    assert.equal(parseDatabaseUrl("postgresql://dev@localhost:/wabista_dev", {}).connectionUrl, "postgresql://dev@localhost:5432/wabista_dev");
  });

  test("the connection URL keeps the user, password and path text exactly (only the port is added)", () => {
    for (const raw of [
      "postgresql://wabista:50%off:now@localhost/wabista_dev",
      "postgresql://us;er:p%ss=1@127.0.0.1/wabista_dev?sslmode=disable",
      "postgresql://dev:p%40ss@localhost/wabista_dev",
    ]) {
      const { connectionUrl } = parseDatabaseUrl(raw, {});
      assert.equal(connectionUrl, raw.replace(/@(localhost|127\.0\.0\.1)\//, "@$1:5432/"));
    }
  });

  test("the guard stamp binds mode and exact URL", () => {
    assert.match(guardStamp(MODES.disposable, DEV_URL), /^disposable-local:[0-9a-f]{64}$/);
    assert.notEqual(guardStamp(MODES.disposable, DEV_URL), guardStamp(MODES.disposable, `${DEV_URL}?sslmode=disable`));
    assert.notEqual(guardStamp(MODES.disposable, DEV_URL).split(":")[1], undefined);
  });
});

describe("apply-sql additive check", () => {
  test("accepts drizzle-style additive SQL", () => {
    const statements = checkAdditiveSql(`
      CREATE TABLE "auth_session" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL,
        "note" text DEFAULT 'drop table x; delete from y',
        "deleted_at" timestamp,
        updated_at timestamp DEFAULT now() NOT NULL
      );
      --> statement-breakpoint
      ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
      CREATE UNIQUE INDEX IF NOT EXISTS "auth_session_user_idx" ON "auth_session" USING btree ("user_id");
      ALTER TABLE auth_user ADD COLUMN IF NOT EXISTS "image" text, ADD COLUMN "drop" boolean;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      ALTER TYPE "public"."member_role" ADD VALUE 'auditor';
      COMMENT ON TABLE "auth_session" IS 'sessions';
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE TYPE "public"."auth_role" AS ENUM('user', 'admin');
      CREATE TYPE pair AS (a integer, b text);
      CREATE SEQUENCE IF NOT EXISTS auth_seq;
      CREATE TABLE "auth_verification" ("id" serial, "expires_at" timestamp with time zone DEFAULT now() NOT NULL, "n" integer DEFAULT nextval('auth_seq'), "token" text DEFAULT md5(random()::text));
    `);
    assert.equal(statements.length, 12);
  });

  for (const [name, sql, pattern] of [
    ["DROP TABLE", "DROP TABLE users;", /DROP is refused/],
    ["DROP hidden after a valid statement", "CREATE INDEX a ON t (c); drop index a;", /DROP is refused/],
    ["TRUNCATE", "TRUNCATE campaigns;", /TRUNCATE is refused/],
    ["DELETE", "DELETE FROM campaigns;", /DELETE is refused/],
    ["UPDATE", "UPDATE campaigns SET status = 'x';", /UPDATE is refused/],
    ["RENAME", 'ALTER TABLE "a" RENAME TO "b";', /RENAME is refused/],
    ["ALTER TABLE DROP COLUMN", 'ALTER TABLE "a" DROP COLUMN "b";', /DROP is refused/],
    ["ALTER COLUMN TYPE", 'ALTER TABLE "a" ALTER COLUMN "b" TYPE integer;', /not additive/],
    ["ALTER COLUMN SET NOT NULL", 'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;', /not additive/],
    ["mixed ADD and non-ADD", 'ALTER TABLE "a" ADD COLUMN "c" text, ALTER COLUMN "b" SET DEFAULT 1;', /not additive/],
    ["CREATE OR REPLACE", "CREATE OR REPLACE VIEW v AS SELECT 1;", /REPLACE is refused/],
    ["DO block", "DO $$ BEGIN EXECUTE 'drop table x'; END $$;", /dollar quoting/],
    ["block comment", "/* hidden */ CREATE TABLE t (id int);", /block comments/],
    ["E'' string", "COMMENT ON TABLE t IS E'it\\'s';", /E'' escape strings/],
    ["INSERT", "INSERT INTO t VALUES (1);", /INSERT is refused/],
    ["GRANT", "GRANT ALL ON t TO public;", /not an accepted additive statement/],
    ["transaction control", "BEGIN; CREATE TABLE t (id int); COMMIT;", /not an accepted additive statement/],
    ["COMMENT ON DATABASE (the marker)", "COMMENT ON DATABASE wabista_dev IS 'x';", /not an accepted additive statement/],
    ["CONCURRENTLY", "CREATE INDEX CONCURRENTLY a ON t (c);", /CONCURRENTLY/],
    ["unterminated string", "COMMENT ON TABLE t IS 'oops;", /unterminated string/],
    ["empty file", "-- nothing\n", /no statements/],
    ["a statement hidden after a \\r-terminated comment", "CREATE TABLE t1 (id int) --\r; DROP TABLE campaigns; --\n;", /DROP is refused/],
    ["CREATE TABLE AS SELECT", "CREATE TABLE t2 AS SELECT * FROM campaigns;", /SELECT is refused/],
    ["CREATE TABLE AS VALUES", "CREATE TABLE t2 AS VALUES (1);", /AS VALUES is refused/],
    ["CREATE TABLE AS EXECUTE", "CREATE TABLE t2 AS EXECUTE q;", /AS EXECUTE is refused/],
    ["INHERITS", "CREATE TABLE t3 () INHERITS (campaigns);", /INHERITS is refused/],
    ["PARTITION OF", "CREATE TABLE t4 PARTITION OF campaigns FOR VALUES IN (1);", /PARTITION OF is refused/],
    ["the dblink extension", "CREATE EXTENSION IF NOT EXISTS dblink;", /only CREATE EXTENSION IF NOT EXISTS pg_trgm or pgcrypto/],
    ["a quoted dblink extension", 'CREATE EXTENSION IF NOT EXISTS "dblink";', /only CREATE EXTENSION IF NOT EXISTS pg_trgm or pgcrypto/],
    ["a procedural language extension", "CREATE EXTENSION IF NOT EXISTS plpython3u;", /only CREATE EXTENSION IF NOT EXISTS pg_trgm or pgcrypto/],
    ["an extension in another schema", "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA other;", /only CREATE EXTENSION/],
    ["CREATE EXTENSION without IF NOT EXISTS", "CREATE EXTENSION pg_trgm;", /only CREATE EXTENSION/],
    ["a side-effecting DEFAULT", 'ALTER TABLE campaigns ADD COLUMN x text DEFAULT "pg_terminate_backend"(1)::text;', /pg_terminate_backend\(\) is refused/],
    ["dblink_exec in a DEFAULT", "ALTER TABLE t ADD COLUMN x text DEFAULT public.dblink_exec('x');", /dblink_exec\(\) is refused/],
    ["set_config in a CHECK", "ALTER TABLE t ADD CONSTRAINT c CHECK (set_config('a.b', 'c', false) IS NOT NULL);", /set_config\(\) is refused/],
    ["query_to_xml", "ALTER TABLE t ADD COLUMN x xml DEFAULT query_to_xml('x', true, false, '');", /query_to_xml\(\) is refused/],
    ["lo_import", "ALTER TABLE t ADD COLUMN x oid DEFAULT lo_import('/etc/passwd');", /lo_import\(\) is refused/],
    ["a base type", "CREATE TYPE t5 (INPUT = int4in, OUTPUT = int4out);", /not an accepted additive statement/],
    ["a backslash outside a string", "CREATE TABLE t6 (id int) \\gexec", /backslashes outside string literals/],
    ["a U& escaped function name", 'ALTER TABLE t ADD COLUMN x text DEFAULT U&"pg_\\0072ead_file"(\'/etc/passwd\');', /Unicode-escape/],
    ["a lower-case u& escaped function name", 'ALTER TABLE t ADD CONSTRAINT c CHECK (u&"set_confi\\0067"(\'a.b\', \'c\', false) IS NOT NULL);', /Unicode-escape/],
    ["a U& escaped string", "COMMENT ON TABLE t IS U&'d\\0061ta';", /Unicode-escape/],
    ["a backslash in a quoted identifier", 'CREATE TABLE "a\\b" (id int);', /backslashes in quoted identifiers/],
    ["CREATE TABLE AS (TABLE ...)", "CREATE TABLE t2 AS (TABLE users);", /AS \(TABLE is refused|AS \( TABLE is refused/],
    ["CREATE TABLE AS(VALUES ...)", "CREATE TABLE t2 AS(VALUES (1));", /is refused/],
    ["CREATE TABLE (cols) AS (TABLE ...)", "CREATE TABLE t2 (a) AS (TABLE users);", /is refused/],
    ["INSERT through a CTE", "CREATE TABLE t2 AS (WITH x AS (INSERT INTO users (email) VALUES ('a') RETURNING id) TABLE x);", /is refused/],
    ["INSERT inside a parenthesised expression", "ALTER TABLE t ADD COLUMN x int DEFAULT (1), ADD CONSTRAINT c CHECK ((INSERT));", /INSERT is refused/],
    ["MERGE", "MERGE INTO t USING s ON true WHEN MATCHED THEN DO NOTHING;", /MERGE is refused/],
  ]) {
    test(`refuses ${name}`, () => {
      assert.throws(() => checkAdditiveSql(sql), (error) => error instanceof DatabaseGuardRefusal && pattern.test(error.message));
    });
  }
});

describe("command line (no database connection is made)", () => {
  const work = mkdtempSync(path.join(tmpdir(), "db-guard-test-"));
  after(() => rmSync(work, { recursive: true, force: true }));

  // A port nothing listens on: if a refusal were missed, the command would fail to connect instead of
  // touching a database, and the exit code / message checks below would catch it.
  const UNREACHABLE = "postgresql://dev@127.0.0.1:1/wabista_dev";
  const run = (args, env) =>
    spawnSync(args[0], args.slice(1), {
      cwd: libDbDir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      timeout: 120_000,
    });
  const node = (script, args, env) => run([process.execPath, path.join(scriptsDir, script), ...args], env);

  test("a bare drizzle-kit push is refused by drizzle.config.ts", () => {
    const result = run([path.join(libDbDir, "node_modules", ".bin", "drizzle-kit"), "push", "--config", "./drizzle.config.ts"], {
      DATABASE_URL: UNREACHABLE,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Refusing to run drizzle-kit outside the database guard/);
  });

  test("a stamp for another URL is refused by drizzle.config.ts", () => {
    const result = run([path.join(libDbDir, "node_modules", ".bin", "drizzle-kit"), "push", "--config", "./drizzle.config.ts"], {
      DATABASE_URL: UNREACHABLE,
      WABISTA_DB_GUARD_STAMP: guardStamp(MODES.disposable, "postgresql://dev@127.0.0.1:1/other"),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Refusing to run drizzle-kit outside the database guard/);
  });

  test("--force with a disposable stamp is refused by drizzle.config.ts", () => {
    const result = run([path.join(libDbDir, "node_modules", ".bin", "drizzle-kit"), "push", "--force", "--config", "./drizzle.config.ts"], {
      DATABASE_URL: UNREACHABLE,
      WABISTA_DB_GUARD_STAMP: guardStamp(MODES.disposable, UNREACHABLE),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Refusing drizzle-kit --force outside the benchmark flow/);
  });

  test("--force=true with a disposable stamp is refused by drizzle.config.ts", () => {
    const result = run([path.join(libDbDir, "node_modules", ".bin", "drizzle-kit"), "push", "--force=true", "--config", "./drizzle.config.ts"], {
      DATABASE_URL: UNREACHABLE,
      WABISTA_DB_GUARD_STAMP: guardStamp(MODES.disposable, UNREACHABLE),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Refusing drizzle-kit --force outside the benchmark flow/);
  });

  test("push.mjs without WABISTA_DB_TARGET", () => {
    const result = node("push.mjs", [], { DATABASE_URL: UNREACHABLE });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: WABISTA_DB_TARGET/);
  });

  test("push.mjs with an unknown argument (no --force passthrough)", () => {
    const result = node("push.mjs", ["--force"], { DATABASE_URL: UNREACHABLE, WABISTA_DB_TARGET: "disposable-local" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: unknown argument --force/);
  });

  test("push-force against a development database", () => {
    const result = node("push.mjs", ["--benchmark-force"], {
      DATABASE_URL: UNREACHABLE,
      CAMPAIGN_BENCHMARK_DATABASE_URL: UNREACHABLE,
      CAMPAIGN_BENCHMARK_CONFIRM: "wabista_dev",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: database "wabista_dev" has no bench\/benchmark name segment/);
  });

  test("push.mjs against the production database name", () => {
    const result = node("push.mjs", [], { DATABASE_URL: "postgresql://cowabista:secret-pw@127.0.0.1:1/cowabista", WABISTA_DB_TARGET: "disposable-local" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: database "cowabista" is the production database/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-pw/);
  });

  test("apply-sql --check accepts an additive file and refuses a destructive one", () => {
    const good = path.join(work, "good.sql");
    const bad = path.join(work, "bad.sql");
    writeFileSync(good, 'CREATE TABLE "t" ("id" text PRIMARY KEY);\n');
    writeFileSync(bad, 'CREATE TABLE "t" ("id" text);\nDROP TABLE "campaigns";\n');
    const ok = node("apply-sql.mjs", ["--check", good], {});
    assert.equal(ok.status, 0, ok.stderr);
    const refused = node("apply-sql.mjs", ["--check", bad], {});
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /REFUSED: statement 2 .*DROP is refused/);
  });

  test("apply-sql against a benchmark database", () => {
    const good = path.join(work, "good2.sql");
    writeFileSync(good, 'CREATE TABLE "t" ("id" text PRIMARY KEY);\n');
    const result = node("apply-sql.mjs", [good], { DATABASE_URL: "postgresql://dev@127.0.0.1:1/campaign_benchmark", WABISTA_DB_TARGET: "disposable-local" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: database "campaign_benchmark" is never a disposable schema target/);
  });

  test("reset-disposable-local on Host S", () => {
    const result = node("reset-disposable-local.mjs", [], { DATABASE_URL: "postgresql://dev@10.0.0.4:5432/wabista_dev", WABISTA_DB_TARGET: "disposable-local" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: host "10\.0\.0\.4" is denied/);
  });

  test("reset-disposable-local in production mode", () => {
    const result = node("reset-disposable-local.mjs", [], { DATABASE_URL: UNREACHABLE, WABISTA_DB_TARGET: "disposable-local", NODE_ENV: "production" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: NODE_ENV=production/);
  });
});
