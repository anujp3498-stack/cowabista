import { parseArgs } from "node:util";

// Operator command for accounts while public sign-up is closed (decision U2, Option 2a). Run it interactively,
// as the service user, on a host that has the API environment; never through dist/index.mjs, which would also
// start the campaign runtime. Check the person's identity out of band before create or reset-password.
//   node --env-file=<API env file> dist/auth-admin.mjs create --email <email> --name "<name>"
//   node --env-file=<API env file> dist/auth-admin.mjs reset-password --email <email>
//   node --env-file=<API env file> dist/auth-admin.mjs revoke-sessions --email <email>
// create and reset-password print a random temporary password exactly once, and only to a terminal. It is never
// an argument, an environment variable, a log field or a file; the database keeps only Better Auth's hash.
// Deliver it through a separate channel; the person signs in and changes it (account menu, Change password).
// Exit status: 0 done; 1 refused (duplicate or unknown email, bad input) or failed; 2 usage or not a terminal.

const USAGE = [
  "usage: auth-admin create --email <email> --name <name>",
  "       auth-admin reset-password --email <email>",
  "       auth-admin revoke-sessions --email <email>",
].join("\n");

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

let parsed: ReturnType<typeof parseArgs<{ options: { email: { type: "string" }; name: { type: "string" } }; allowPositionals: true; strict: true }>>;
try {
  parsed = parseArgs({ args: process.argv.slice(2), options: { email: { type: "string" }, name: { type: "string" } }, allowPositionals: true, strict: true });
} catch (error) {
  usage(error instanceof Error ? error.message : "invalid arguments");
}
const [command, ...extra] = parsed.positionals;
const { email, name } = parsed.values;
if (extra.length || !command || !["create", "reset-password", "revoke-sessions"].includes(command)) usage("unknown or missing command");
if (!email) usage("--email is required");
if (command === "create" && name === undefined) usage("--name is required for create");
if (command !== "create" && name !== undefined) usage("--name is only for create");
if (command !== "revoke-sessions" && !process.stdout.isTTY) {
  usage("refusing: the temporary password is shown only on an interactive terminal (stdout is not a terminal)");
}

// Imported only now: lib/auth validates the environment (and refuses a bad one) when it is loaded.
const { auth } = await import("./lib/auth");
const admin = await import("./lib/auth-admin");
const { logger } = await import("./lib/logger");
const { pool, settlementPool } = await import("@workspace/db");

const operator = process.env.SUDO_USER ?? process.env.USER ?? "unknown";
function showOnce(headline: string, temporaryPassword: string) {
  process.stdout.write(
    `${headline}\nTemporary password (shown once; it is not stored or logged): ${temporaryPassword}\n` +
      "Give it to the person through a separate channel. They sign in, then change it (account menu, Change password).\n",
  );
}

try {
  if (command === "create") {
    const result = await admin.createOperatorAccount(auth, { email, name: name ?? "" });
    logger.info({ action: "auth-admin.create", authUserId: result.authUserId, operator }, "operator created an account");
    showOnce(`Account created for ${result.email}.`, result.temporaryPassword);
  } else if (command === "reset-password") {
    const result = await admin.resetOperatorPassword(auth, { email });
    logger.info({ action: "auth-admin.reset-password", authUserId: result.authUserId, operator }, "operator reset a password; every session ended");
    showOnce(`Password reset for ${result.email}; every session was ended.`, result.temporaryPassword);
  } else {
    const result = await admin.revokeAllSessions(auth, { email });
    logger.info({ action: "auth-admin.revoke-sessions", authUserId: result.authUserId, operator }, "operator ended every session");
    process.stdout.write(`Every session of ${result.email} was ended.\n`);
  }
} catch (error) {
  process.exitCode = 1;
  if (error instanceof admin.AuthAdminError) process.stderr.write(`refused: ${error.message}\n`);
  else logger.error({ err: error, action: `auth-admin.${command}`, operator }, "auth-admin failed");
} finally {
  await Promise.allSettled([pool.end(), settlementPool.end()]);
}
