#!/usr/bin/env node
// Creates, or drops and re-creates, the disposable LOCAL development database named by DATABASE_URL, and
// marks it with the database comment the guard requires (`wabista:disposable-local`). Then run the guarded
// `pnpm --filter @workspace/db run push` to create the schema.
//
//   WABISTA_DB_TARGET=disposable-local pnpm --filter @workspace/db run reset-disposable-local
//
// Refuses everything assert-safe-database.mjs refuses in disposable mode and, in addition, any host that is
// not loopback (WABISTA_DB_APPROVED_DEV_HOSTS is not honoured here). An existing database WITHOUT the marker
// is never dropped. The DATABASE_URL role needs CREATEDB; the script connects to the server's `postgres`
// maintenance database to create and drop.
import {
  checkTargetBeforeConnect,
  connect,
  DatabaseGuardRefusal,
  DISPOSABLE_MARKER,
  MODES,
  runGuarded,
  verifyServerAddress,
} from "./assert-safe-database.mjs";

function refuse(message) {
  throw new DatabaseGuardRefusal(message);
}

await runGuarded(async () => {
  if (process.argv.length > 2) refuse("usage: reset-disposable-local.mjs (the target is DATABASE_URL's database)");
  const target = await checkTargetBeforeConnect({ mode: MODES.disposable, allowApprovedHosts: false });
  const name = target.database;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    refuse(`database name "${name}" must be lower-case letters, digits and underscores`);
  }

  const maintenanceUrl = new URL(target.databaseUrl);
  maintenanceUrl.pathname = "/postgres";
  const client = await connect(maintenanceUrl.toString());
  try {
    const { rows: serverRows } = await client.query("select host(inet_server_addr()) as server_address");
    verifyServerAddress(serverRows[0]?.server_address ?? null, target);

    const { rows } = await client.query(
      "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = $1",
      [name],
    );
    if (rows.length && rows[0].marker !== DISPOSABLE_MARKER) {
      refuse(`database "${name}" exists and is not marked disposable; it is never dropped by this script`);
    }
    if (rows.length) {
      await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      console.log(`[db-guard] dropped disposable database ${name}`);
    }
    await client.query(`CREATE DATABASE "${name}"`);
    await client.query(`COMMENT ON DATABASE "${name}" IS '${DISPOSABLE_MARKER}'`);
  } finally {
    await client.end();
  }
  console.log(`[db-guard] created ${target.redacted} and marked it ${DISPOSABLE_MARKER}`);
  console.log("[db-guard] next: pnpm --filter @workspace/db run push");
  return 0;
});
