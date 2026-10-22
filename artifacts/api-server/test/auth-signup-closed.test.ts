// Option 2a over real HTTP on the disposable local database, with AUTH_PUBLIC_SIGN_UP unset exactly as in
// production: self sign-up is refused before Better Auth sees it; accounts come only from the operator command
// (src/auth-admin.ts, src/lib/auth-admin.ts), whose temporary password is random, shown once on a terminal and
// stored only as a hash; those accounts sign in, sign out and change their password (session, trusted origin,
// current password, 12 to 128 characters, every other session revoked, rate limited); the operator can reset a
// password or end every session; invitations still need the token and the invited email. Every request carries
// its own X-Forwarded-For address so rate-limit buckets never collide; everything created is removed.
import { randomBytes, randomUUID } from "node:crypto";

process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
process.env.BETTER_AUTH_URL = "http://localhost:24902";
process.env.CORS_ALLOWED_ORIGINS = "";
process.env.TRUST_PROXY = "1";
delete process.env.AUTH_PUBLIC_SIGN_UP;

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { and, eq, inArray, like } from "drizzle-orm";
import { build } from "esbuild";
import {
  db,
  organizationInvitationsTable,
  organizationMembersTable,
  organizationsTable,
  pool,
  settlementPool,
  usersTable,
} from "@workspace/db";
import { authAccountsTable, authRateLimitsTable, authSessionsTable, authUserLinksTable, authUsersTable } from "@workspace/db/auth";
import { Client, ipAllocator } from "./auth-http-fixtures";

type AuthModule = typeof import("../src/lib/auth");
type AdminModule = typeof import("../src/lib/auth-admin");

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = randomBytes(3).toString("hex");
const ips = ipAllocator();
const emails: string[] = [];
const newEmail = (label: string) => { const email = `closed-${label}-${RUN}-${emails.length}@example.test`; emails.push(email); return email; };
const orgIds: number[] = [];
const newPassword = () => `new-${randomBytes(12).toString("base64url")}`;

let server: Server;
let base = "";
let authModule: AuthModule;
let admin: AdminModule;
const client = (password = "") => new Client(() => base, ips.next(), password);
/** The same browser (cookies) seen from a new client address, so each call gets its own rate-limit bucket. */
const sameBrowser = (browser: Client) => { const copy = client(browser.password); copy.cookies = new Map(browser.cookies); return copy; };

before(async () => {
  const { default: app } = await import("../src/app");
  authModule = await import("../src/lib/auth");
  admin = await import("../src/lib/auth-admin");
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const authUsers = emails.length ? await db.select({ id: authUsersTable.id }).from(authUsersTable).where(inArray(authUsersTable.email, emails)) : [];
  const links = authUsers.length ? await db.select().from(authUserLinksTable).where(inArray(authUserLinksTable.authUserId, authUsers.map((u) => u.id))) : [];
  const userIds = links.map((link) => link.userId);
  if (userIds.length) {
    const owned = await db.select({ organizationId: organizationMembersTable.organizationId }).from(organizationMembersTable)
      .where(and(inArray(organizationMembersTable.userId, userIds), eq(organizationMembersTable.role, "owner")));
    orgIds.push(...owned.map((o) => o.organizationId));
  }
  if (orgIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(usersTable).where(like(usersTable.clerkId, `closed-owner-${RUN}-%`));
  if (authUsers.length) await db.delete(authUsersTable).where(inArray(authUsersTable.id, authUsers.map((u) => u.id)));
  await db.delete(authRateLimitsTable).where(like(authRateLimitsTable.key, `${ips.block}.%`));
  await Promise.all([pool.end(), settlementPool.end()]);
});

async function authUserByEmail(email: string) {
  const [row] = await db.select().from(authUsersTable).where(eq(authUsersTable.email, email.toLowerCase()));
  return row;
}
const sessionsOf = (authUserId: string) => db.select().from(authSessionsTable).where(eq(authSessionsTable.userId, authUserId));
const credentialOf = async (authUserId: string) => (await db.select().from(authAccountsTable).where(eq(authAccountsTable.userId, authUserId)));
const changePassword = (browser: Client, body: Record<string, unknown>, origin?: string | null) =>
  browser.send("POST", "/api/auth/change-password", { body, origin });

/** An operator-created account, signed in from its own client address. */
async function signedInAccount(label: string) {
  const email = newEmail(label);
  const created = await admin.createOperatorAccount(authModule.auth, { email, name: `Closed ${label}` });
  const browser = client(created.temporaryPassword);
  const reply = await browser.signIn(email);
  assert.equal(reply.status, 200, reply.text);
  return { email, browser, ...created };
}

describe("public sign-up is closed", () => {
  test("POST /api/auth/sign-up/email answers 404 before Better Auth (no user, no session, no rate-limit row); the policy says closed", async () => {
    const probe = client(`pw-${randomBytes(9).toString("base64url")}`);
    const email = newEmail("signup");
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await probe.signUp(email);
      assert.equal(reply.status, 404, `attempt ${attempt}: ${reply.status} ${reply.text}`);
    }
    assert.equal(probe.session, undefined, "no session cookie");
    assert.equal(await authUserByEmail(email), undefined, "no account");
    const rows = await db.select().from(authRateLimitsTable).where(like(authRateLimitsTable.key, `${probe.ip}|%`));
    assert.deepEqual(rows, [], "the refusal never reaches Better Auth's limiter");

    const policy = await client().send("GET", "/api/auth-policy", { origin: null });
    assert.equal(policy.status, 200);
    assert.deepEqual(policy.json, { publicSignUp: false });
    assert.match(String(policy.headers["cache-control"]), /no-store/);
  });

  test("the server-side sign-up API refuses too (Better Auth's own disableSignUp)", async () => {
    const email = newEmail("server");
    await assert.rejects(
      authModule.auth.api.signUpEmail({ body: { name: "Server Side", email, password: `pw-${randomBytes(12).toString("base64url")}` } }),
      (error: { body?: { code?: string } }) => { assert.equal(error.body?.code, "EMAIL_PASSWORD_SIGN_UP_DISABLED"); return true; },
    );
    assert.equal(await authUserByEmail(email), undefined);
  });
});

describe("operator-created accounts", () => {
  test("create: a random temporary password of 12-128 characters stored only as a scrypt hash; unverified; no session; email lowercased", async () => {
    const email = newEmail("create");
    const created = await admin.createOperatorAccount(authModule.auth, { email: `  ${email.toUpperCase()} `, name: "  Operator Made " });
    assert.equal(created.email, email);
    assert.ok(created.temporaryPassword.length >= 12 && created.temporaryPassword.length <= 128, "12 to 128 characters");
    assert.match(created.temporaryPassword, /^[A-Za-z0-9_-]+$/, "copy-paste safe characters");
    const user = await authUserByEmail(email);
    assert.ok(user);
    assert.equal(user.id, created.authUserId);
    assert.equal(user.name, "Operator Made");
    assert.equal(user.emailVerified, false, "an operator-created account is not marked verified");
    const accounts = await credentialOf(user.id);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.providerId, "credential");
    assert.equal(accounts[0]!.accountId, user.id);
    assert.match(accounts[0]!.password ?? "", /^[0-9a-f]{32}:[0-9a-f]{128}$/, "scrypt salt:key, never the password");
    assert.ok(!(accounts[0]!.password ?? "").includes(created.temporaryPassword));
    assert.deepEqual(await sessionsOf(user.id), [], "creating an account signs nobody in");

    const other = await admin.createOperatorAccount(authModule.auth, { email: newEmail("create-other"), name: "Other" });
    assert.notEqual(other.temporaryPassword, created.temporaryPassword);
  });

  test("create refuses an existing email (any case), a malformed email and a bad name, and leaves nothing behind", async () => {
    const email = newEmail("dupe");
    await admin.createOperatorAccount(authModule.auth, { email, name: "First" });
    await assert.rejects(admin.createOperatorAccount(authModule.auth, { email: email.toUpperCase(), name: "Second" }),
      (error: Error) => error instanceof admin.AuthAdminError && /already exists/.test(error.message));
    assert.equal((await db.select().from(authUsersTable).where(eq(authUsersTable.email, email))).length, 1);

    for (const bad of ["", "   ", "no-at-sign", "a@b", "two@@example.test", "spaces in@example.test", "x@example.test\nBcc: y@example.test", `${"x".repeat(250)}@example.test`]) {
      await assert.rejects(admin.createOperatorAccount(authModule.auth, { email: bad, name: "Bad Email" }),
        (error: Error) => error instanceof admin.AuthAdminError && /email/i.test(error.message), JSON.stringify(bad));
    }
    const nameless = newEmail("nameless");
    for (const name of ["", "   ", "n".repeat(101)]) {
      await assert.rejects(admin.createOperatorAccount(authModule.auth, { email: nameless, name }),
        (error: Error) => error instanceof admin.AuthAdminError && /name/i.test(error.message), JSON.stringify(name));
    }
    assert.equal(await authUserByEmail(nameless), undefined);
  });

  test("an operator-created account signs in with the temporary password, reads /api/me, signs out and signs in again", async () => {
    const { email, browser, authUserId, temporaryPassword } = await signedInAccount("signin");
    const me = await browser.send("GET", "/api/me");
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.email, email);
    assert.equal((await sessionsOf(authUserId)).length, 1);

    const out = await browser.send("POST", "/api/auth/sign-out", { body: {} });
    assert.equal(out.status, 200, out.text);
    assert.deepEqual(await sessionsOf(authUserId), [], "sign-out deletes the session");
    assert.equal((await browser.send("GET", "/api/me")).status, 401);

    const again = client(temporaryPassword);
    assert.equal((await again.signIn(email)).status, 200);
    assert.equal((await again.send("GET", "/api/me")).status, 200);
    const wrong = await client(temporaryPassword).signIn(email, `${temporaryPassword}x`);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, "INVALID_EMAIL_OR_PASSWORD");
  });
});

describe("change-password", () => {
  test("needs a session, a trusted origin, the current password, 12-128 characters and revokeOtherSessions: true", async () => {
    const { email, browser, temporaryPassword } = await signedInAccount("cp-guard");
    const next = newPassword();
    const valid = { currentPassword: temporaryPassword, newPassword: next, revokeOtherSessions: true };

    assert.equal((await changePassword(client(temporaryPassword), valid)).status, 401, "no session");
    assert.equal((await changePassword(sameBrowser(browser), valid, "https://evil.example")).status, 403, "untrusted origin");
    assert.equal((await changePassword(sameBrowser(browser), valid, null)).status, 403, "no origin");

    const wrongCurrent = await changePassword(sameBrowser(browser), { ...valid, currentPassword: `${temporaryPassword}x` });
    assert.equal(wrongCurrent.status, 400);
    assert.equal(wrongCurrent.json.code, "INVALID_PASSWORD");
    const short = await changePassword(sameBrowser(browser), { ...valid, newPassword: "a1b2c3d4e5f" });
    assert.equal(short.status, 400);
    assert.equal(short.json.code, "PASSWORD_TOO_SHORT");
    const long = await changePassword(sameBrowser(browser), { ...valid, newPassword: "x".repeat(129) });
    assert.equal(long.status, 400);
    assert.equal(long.json.code, "PASSWORD_TOO_LONG");
    for (const revokeOtherSessions of [undefined, false]) {
      const kept = await changePassword(sameBrowser(browser), { ...valid, revokeOtherSessions });
      assert.equal(kept.status, 400, String(revokeOtherSessions));
      assert.equal(kept.json.code, "REVOKE_OTHER_SESSIONS_REQUIRED");
    }

    // Every refusal left the password unchanged.
    assert.equal((await client(temporaryPassword).signIn(email)).status, 200);
  });

  test("success revokes every other session, issues a new session cookie, and only the new password signs in", async () => {
    const { email, browser, authUserId, temporaryPassword } = await signedInAccount("cp-ok");
    const elsewhere = client(temporaryPassword);
    assert.equal((await elsewhere.signIn(email)).status, 200);
    assert.equal((await sessionsOf(authUserId)).length, 2);
    const hashBefore = (await credentialOf(authUserId))[0]!.password;
    const cookieBefore = browser.session;

    const next = newPassword();
    const reply = await changePassword(browser, { currentPassword: temporaryPassword, newPassword: next, revokeOtherSessions: true });
    assert.equal(reply.status, 200, reply.text);
    for (const value of [next, temporaryPassword, hashBefore ?? "-"]) assert.ok(!reply.text.includes(value), "no password material in the response");
    assert.ok(browser.session && browser.session !== cookieBefore, "a new session cookie replaces the old one");
    assert.equal((await sessionsOf(authUserId)).length, 1, "only the new session remains");
    assert.equal((await elsewhere.send("GET", "/api/me")).status, 401, "the other session is revoked");
    assert.equal((await browser.send("GET", "/api/me")).status, 200, "this browser stays signed in");

    const hashAfter = (await credentialOf(authUserId))[0]!.password;
    assert.notEqual(hashAfter, hashBefore);
    assert.ok(!(hashAfter ?? "").includes(next));
    assert.equal((await client(temporaryPassword).signIn(email)).status, 401, "the old password no longer works");
    assert.equal((await client(next).signIn(email)).status, 200, "the new password works");
  });

  test("is limited to 3 requests per 10 seconds per client address", async () => {
    const { browser, temporaryPassword } = await signedInAccount("cp-limit");
    const wrong = { currentPassword: `${temporaryPassword}x`, newPassword: newPassword(), revokeOtherSessions: true };
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) statuses.push((await changePassword(browser, wrong)).status);
    assert.deepEqual(statuses, [400, 400, 400, 429]);
  });
});

describe("operator recovery", () => {
  test("reset-password: a new temporary password, the old one stops working, and every session ends", async () => {
    const { email, browser, authUserId, temporaryPassword } = await signedInAccount("reset");
    const reset = await admin.resetOperatorPassword(authModule.auth, { email: email.toUpperCase() });
    assert.equal(reset.authUserId, authUserId);
    assert.notEqual(reset.temporaryPassword, temporaryPassword);
    assert.ok(reset.temporaryPassword.length >= 12);
    assert.deepEqual(await sessionsOf(authUserId), [], "every session ended");
    assert.equal((await browser.send("GET", "/api/me")).status, 401);
    assert.equal((await client(temporaryPassword).signIn(email)).status, 401);
    assert.equal((await client(reset.temporaryPassword).signIn(email)).status, 200);
    assert.ok(!((await credentialOf(authUserId))[0]!.password ?? "").includes(reset.temporaryPassword));

    await assert.rejects(admin.resetOperatorPassword(authModule.auth, { email: newEmail("nobody") }),
      (error: Error) => error instanceof admin.AuthAdminError && /no account/i.test(error.message));
  });

  test("revoke-sessions: every session ends and the password is unchanged", async () => {
    const { email, browser, authUserId, temporaryPassword } = await signedInAccount("revoke");
    const second = client(temporaryPassword);
    assert.equal((await second.signIn(email)).status, 200);
    const result = await admin.revokeAllSessions(authModule.auth, { email });
    assert.equal(result.authUserId, authUserId);
    assert.deepEqual(await sessionsOf(authUserId), []);
    assert.equal((await browser.send("GET", "/api/me")).status, 401);
    assert.equal((await second.send("GET", "/api/me")).status, 401);
    assert.equal((await client(temporaryPassword).signIn(email)).status, 200);
  });
});

describe("invitations are unchanged", () => {
  test("an operator-created invitee joins only with the token while signed in with the invited email", async () => {
    const [organization] = await db.insert(organizationsTable).values({ name: "Closed Team", slug: `closed-team-${RUN}` }).returning();
    orgIds.push(organization!.id);
    const [owner] = await db.insert(usersTable).values({ clerkId: `closed-owner-${RUN}-1`, email: `closed-owner-${RUN}@example.test`, name: "Owner" }).returning();
    await db.insert(organizationMembersTable).values({ organizationId: organization!.id, userId: owner!.id, role: "owner" });
    const invitee = newEmail("invitee");
    const [invitation] = await db.insert(organizationInvitationsTable)
      .values({ organizationId: organization!.id, email: invitee, role: "manager", invitedByUserId: owner!.id, token: randomUUID() }).returning();

    const intruder = await signedInAccount("intruder");
    const refused = await intruder.browser.send("POST", "/api/invitations/accept", { body: { token: invitation!.token } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, "invitation_email_mismatch");

    const created = await admin.createOperatorAccount(authModule.auth, { email: invitee, name: "Invitee" });
    const browser = client(created.temporaryPassword);
    assert.equal((await browser.signIn(invitee)).status, 200);
    const accepted = await browser.send("POST", "/api/invitations/accept", { body: { token: invitation!.token } });
    assert.equal(accepted.status, 200, accepted.text);
    assert.deepEqual(accepted.json, { organizationId: organization!.id, role: "manager" });
    const again = await browser.send("POST", "/api/invitations/accept", { body: { token: invitation!.token } });
    assert.equal(again.status, 409);
  });
});

describe("operator command (src/auth-admin.ts)", () => {
  const harnessDir = path.join(artifactDir, ".test-dist", "auth-admin-cli");
  const cli = path.join(harnessDir, "auth-admin.mjs");

  before(async () => {
    await rm(harnessDir, { recursive: true, force: true });
    await build({
      entryPoints: [path.join(artifactDir, "src", "auth-admin.ts")],
      outfile: cli,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
      logLevel: "error",
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
    });
  });

  after(async () => {
    await rm(harnessDir, { recursive: true, force: true });
  });

  function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: artifactDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, output }));
    });
  }
  /** Runs the command on a pseudo-terminal (util-linux script), as an operator would; arguments pass via env. */
  const terminal = (args: string[]) =>
    run("script", ["-qec", `exec "$AUTH_ADMIN_NODE" "$AUTH_ADMIN_CLI" ${args.map((_, i) => `"$AUTH_ADMIN_ARG${i}"`).join(" ")}`, "/dev/null"], {
      AUTH_ADMIN_NODE: process.execPath, AUTH_ADMIN_CLI: cli, LOG_LEVEL: "debug",
      ...Object.fromEntries(args.map((value, i) => [`AUTH_ADMIN_ARG${i}`, value])),
    });

  test("usage errors and a non-terminal stdout exit 2 without creating anything or printing a password", async () => {
    const email = newEmail("cli-pipe");
    const piped = await run(process.execPath, [cli, "create", "--email", email, "--name", "Piped"]);
    assert.equal(piped.code, 2, piped.output);
    assert.match(piped.output, /terminal/);
    assert.equal(await authUserByEmail(email), undefined);
    const pipedReset = await run(process.execPath, [cli, "reset-password", "--email", email]);
    assert.equal(pipedReset.code, 2, pipedReset.output);

    for (const args of [[], ["frobnicate"], ["create", "--email", email], ["create", "--name", "No Email"], ["create", "--email", email, "--name", "X", "--password", "chosen-by-operator"]]) {
      const reply = await run(process.execPath, [cli, ...args]);
      assert.equal(reply.code, 2, `${args.join(" ")}: ${reply.output}`);
      assert.match(reply.output, /usage/i);
    }
    assert.equal(await authUserByEmail(email), undefined);
  });

  test("on a terminal, create and reset-password print the temporary password exactly once; no log line carries it", async () => {
    const email = newEmail("cli-tty");
    const created = await terminal(["create", "--email", email, "--name", "Terminal User"]);
    assert.equal(created.code, 0, created.output);
    const first = /Temporary password[^:]*:\s*(\S+)/.exec(created.output)?.[1];
    assert.ok(first, created.output);
    assert.equal(created.output.split(first).length - 1, 1, "printed exactly once, never logged");
    assert.equal((await client(first).signIn(email)).status, 200);

    const reset = await terminal(["reset-password", "--email", email]);
    assert.equal(reset.code, 0, reset.output);
    const second = /Temporary password[^:]*:\s*(\S+)/.exec(reset.output)?.[1];
    assert.ok(second && second !== first, reset.output);
    assert.equal(reset.output.split(second).length - 1, 1);
    assert.equal((await client(first).signIn(email)).status, 401);
    assert.equal((await client(second).signIn(email)).status, 200);

    const duplicate = await terminal(["create", "--email", email, "--name", "Again"]);
    assert.equal(duplicate.code, 1, duplicate.output);
    assert.match(duplicate.output, /already exists/);
    assert.doesNotMatch(duplicate.output, /Temporary password/);

    const revoked = await run(process.execPath, [cli, "revoke-sessions", "--email", email]);
    assert.equal(revoked.code, 0, revoked.output);
    assert.deepEqual(await sessionsOf((await authUserByEmail(email))!.id), []);
  });
});
