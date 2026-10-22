// Better Auth over real HTTP (src/app.ts on the disposable local database): sign-up, sign-in, sign-out,
// session resolution, expiry and sliding refresh, the local user and personal workspace created on first use,
// the active-organization cookie, roles, origin/CSRF checks, the shared (database) sign-in rate limit across
// two server processes, body limits, and that no password, session token, password hash or secret reaches a
// response or the server's log output. Every request carries its own X-Forwarded-For address so rate-limit
// buckets never collide; everything created here is removed at the end. Public sign-up is closed by default
// (AUTH_PUBLIC_SIGN_UP, Option 2a; closed mode is covered by auth-signup-closed.test.ts): this suite opts in to
// open sign-up, outside production only, to keep Better Auth's own sign-up hardening covered.
import { randomBytes } from "node:crypto";

const SECRET = randomBytes(32).toString("base64");
const ORIGIN = "http://localhost:24902";
process.env.BETTER_AUTH_SECRET = SECRET;
process.env.BETTER_AUTH_URL = ORIGIN;
process.env.CORS_ALLOWED_ORIGINS = "";
process.env.TRUST_PROXY = "1";
process.env.AUTH_PUBLIC_SIGN_UP = "open";

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { build } from "esbuild";
import { db, organizationMembersTable, organizationsTable, pool, settlementPool, usersTable } from "@workspace/db";
import { authAccountsTable, authRateLimitsTable, authSessionsTable, authUserLinksTable, authUsersTable } from "@workspace/db/auth";
import { call, Client, cookieAttributes, ipAllocator } from "./auth-http-fixtures";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = randomBytes(3).toString("hex");
const ips = ipAllocator();
const IP_BLOCK = ips.block;
const emails: string[] = [];
const newEmail = (label: string) => { const email = `auth-${label}-${RUN}-${emails.length}@example.test`; emails.push(email); return email; };
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;

let server: Server;
let base = "";
const client = () => new Client(() => base, ips.next(), PASSWORD);

async function authUserByEmail(email: string) {
  const [row] = await db.select().from(authUsersTable).where(eq(authUsersTable.email, email.toLowerCase()));
  return row;
}

async function localUserFor(authUserId: string) {
  const [row] = await db.select({ user: usersTable }).from(authUserLinksTable).innerJoin(usersTable, eq(usersTable.id, authUserLinksTable.userId)).where(eq(authUserLinksTable.authUserId, authUserId));
  return row?.user;
}

before(async () => {
  const { default: app } = await import("../src/app");
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
    if (owned.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, owned.map((o) => o.organizationId)));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  if (authUsers.length) await db.delete(authUsersTable).where(inArray(authUsersTable.id, authUsers.map((u) => u.id)));
  await db.delete(authRateLimitsTable).where(like(authRateLimitsTable.key, `${IP_BLOCK}.%`));
  await Promise.all([pool.end(), settlementPool.end()]);
});

describe("sign-up", () => {
  test("creates the user, a credential account and a session, and sets a Lax HttpOnly session cookie", async () => {
    const browser = client();
    const email = newEmail("signup");
    const reply = await browser.signUp(email.toUpperCase().replace("@EXAMPLE.TEST", "@Example.Test"));
    assert.equal(reply.status, 200, reply.text);
    const cookie = reply.setCookies.map(cookieAttributes).find((c) => c.name === "wabista.session_token");
    assert.ok(cookie, "session cookie set");
    assert.equal(cookie.attributes.get("max-age"), String(60 * 60 * 24 * 7));
    assert.equal(cookie.attributes.get("path"), "/");
    assert.ok(cookie.attributes.has("httponly"));
    assert.equal(cookie.attributes.get("samesite")?.toLowerCase(), "lax");
    assert.ok(!cookie.attributes.has("domain"), "no Domain attribute");
    assert.ok(!cookie.attributes.has("secure"), "not Secure on an http origin");
    assert.deepEqual(Object.keys(reply.json.user).sort(), ["createdAt", "email", "emailVerified", "id", "image", "name", "updatedAt"]);
    assert.equal(reply.json.user.email, email, "the email is stored lowercased");
    assert.equal(reply.json.user.emailVerified, false);
    assert.equal(reply.json.user.image, null);

    const authUser = await authUserByEmail(email);
    assert.ok(authUser);
    const accounts = await db.select().from(authAccountsTable).where(eq(authAccountsTable.userId, authUser.id));
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.providerId, "credential");
    assert.match(accounts[0]!.password ?? "", /^[0-9a-f]{32}:[0-9a-f]{128}$/, "scrypt salt:key, never the password");
    assert.equal((await db.select().from(authSessionsTable).where(eq(authSessionsTable.userId, authUser.id))).length, 1);
    for (const value of [PASSWORD, accounts[0]!.password!, SECRET]) assert.ok(!reply.text.includes(value), "no secret material in the response");

    const duplicate = await client().signUp(email.toUpperCase());
    assert.equal(duplicate.status, 422);
    assert.equal(duplicate.json.code, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");

    const policy = await client().send("GET", "/api/auth-policy", { origin: null });
    assert.equal(policy.status, 200);
    assert.deepEqual(policy.json, { publicSignUp: true }, "this suite runs with sign-up opened");
  });

  test("passwords are 12 to 128 characters; names 1 to 100 characters; a client image is not kept", async () => {
    const tooShort = await client().signUp(newEmail("short"), { password: "a1b2c3d4e5f" });
    assert.equal(tooShort.status, 400);
    assert.equal(tooShort.json.code, "PASSWORD_TOO_SHORT");
    const tooLong = await client().signUp(newEmail("long"), { password: "x".repeat(129) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.code, "PASSWORD_TOO_LONG");
    const longName = await client().signUp(newEmail("name"), { name: "n".repeat(101) });
    assert.equal(longName.status, 400);
    assert.equal(longName.json.code, "INVALID_NAME");
    const blankName = await client().signUp(newEmail("blank"), { name: "   " });
    assert.equal(blankName.status, 400);
    const exactly12 = await client().signUp(newEmail("twelve"), { password: "abcdefghijk1", image: "https://evil.example/x.png" });
    assert.equal(exactly12.status, 200, exactly12.text);
    assert.equal(exactly12.json.user.image, null);
  });
});

describe("session and the local account", () => {
  test("/api/me returns the same five fields; the first requests create exactly one local user, link and personal workspace", async () => {
    const browser = client();
    const email = newEmail("me");
    assert.equal((await browser.signUp(email)).status, 200);
    const replies = await Promise.all(Array.from({ length: 10 }, () => browser.send("GET", "/api/me")));
    assert.ok(replies.every((r) => r.status === 200), replies.map((r) => r.status).join(","));
    assert.deepEqual(Object.keys(replies[0]!.json).sort(), ["createdAt", "email", "id", "isPlatformAdmin", "name"]);
    assert.equal(new Set(replies.map((r) => r.json.id)).size, 1);

    const authUser = (await authUserByEmail(email))!;
    const links = await db.select().from(authUserLinksTable).where(eq(authUserLinksTable.authUserId, authUser.id));
    assert.equal(links.length, 1);
    const users = await db.select().from(usersTable).where(eq(usersTable.clerkId, `better-auth:${authUser.id}`));
    assert.equal(users.length, 1);
    assert.equal(users[0]!.id, links[0]!.userId);
    const memberships = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, users[0]!.id));
    assert.equal(memberships.length, 1, "one personal workspace even under parallel first requests");
    assert.equal(memberships[0]!.role, "owner");
  });

  test("the active-organization cookie is honoured for the user's own workspaces only", async () => {
    const browser = client();
    const email = newEmail("active");
    await browser.signUp(email);
    const first = await browser.send("GET", "/api/organizations");
    assert.equal(first.status, 200);
    const personal = first.json[0].id as number;
    const user = (await localUserFor((await authUserByEmail(email))!.id))!;
    const [second] = await db.insert(organizationsTable).values({ name: `second-${RUN}`, slug: `second-${RUN}-${randomBytes(2).toString("hex")}` }).returning();
    await db.insert(organizationMembersTable).values({ organizationId: second!.id, userId: user.id, role: "owner" });
    const [foreign] = await db.insert(organizationsTable).values({ name: `foreign-${RUN}`, slug: `foreign-${RUN}-${randomBytes(2).toString("hex")}` }).returning();
    try {
      browser.cookies.set("wabista_active_org_id", String(second!.id));
      const switched = await browser.send("GET", "/api/organizations");
      assert.equal(switched.json.find((o: { isActive: boolean }) => o.isActive).id, second!.id);
      browser.cookies.set("wabista_active_org_id", String(foreign!.id));
      const fallback = await browser.send("GET", "/api/organizations");
      assert.equal(fallback.json.find((o: { isActive: boolean }) => o.isActive).id, personal, "a foreign workspace id falls back to the first membership");
      assert.ok(!fallback.json.some((o: { id: number }) => o.id === foreign!.id));
    } finally {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, foreign!.id));
    }
  });

  test("roles are enforced over real HTTP: owner and admin can invite, manager and agent get 403", async () => {
    const owner = client();
    const ownerEmail = newEmail("owner");
    await owner.signUp(ownerEmail);
    const org = (await owner.send("GET", "/api/organizations")).json[0].id as number;
    const results: Record<string, number> = {};
    for (const role of ["admin", "manager", "agent"] as const) {
      const member = client();
      const email = newEmail(role);
      await member.signUp(email);
      const authUser = (await authUserByEmail(email))!;
      await member.send("GET", "/api/me");
      const user = (await localUserFor(authUser.id))!;
      await db.insert(organizationMembersTable).values({ organizationId: org, userId: user.id, role });
      member.cookies.set("wabista_active_org_id", String(org));
      results[role] = (await member.send("POST", "/api/members", { body: { email: `invitee-${role}-${RUN}@example.test`, role: "agent" } })).status;
      assert.equal((await member.send("GET", "/api/members")).status, 200);
    }
    results.owner = (await owner.send("POST", "/api/members", { body: { email: `invitee-owner-${RUN}@example.test`, role: "agent" } })).status;
    assert.deepEqual(results, { admin: 201, manager: 403, agent: 403, owner: 201 });
    assert.equal((await client().send("GET", "/api/members")).status, 401, "anonymous");
  });
});

describe("sign-in, sign-out, expiry and refresh", () => {
  test("a wrong password and an unknown email give the same 401; a correct sign-in issues a new session", async () => {
    const email = newEmail("signin");
    const first = client();
    await first.signUp(email);
    const wrong = await client().signIn(email, `${PASSWORD}x`);
    const unknown = await client().signIn(newEmail("nobody"));
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.json.code, "INVALID_EMAIL_OR_PASSWORD");
    assert.equal(unknown.json.code, wrong.json.code);
    assert.equal(unknown.json.message, wrong.json.message);
    const second = client();
    const ok = await second.signIn(email.toUpperCase());
    assert.equal(ok.status, 200, ok.text);
    assert.ok(second.session && second.session !== first.session, "a fresh session token on every sign-in");
  });

  test("sign-out deletes the session and expires both the session and active-workspace cookies", async () => {
    const browser = client();
    const email = newEmail("signout");
    await browser.signUp(email);
    await browser.send("GET", "/api/me");
    browser.cookies.set("wabista_active_org_id", "1");
    const oldCookie = browser.session!;
    const reply = await browser.send("POST", "/api/auth/sign-out", { body: {} });
    assert.equal(reply.status, 200, reply.text);
    const expired = reply.setCookies.map(cookieAttributes).filter((c) => c.attributes.get("max-age") === "0").map((c) => c.name);
    assert.ok(expired.includes("wabista.session_token"), expired.join(","));
    assert.ok(expired.includes("wabista_active_org_id"), expired.join(","));
    const authUser = (await authUserByEmail(email))!;
    assert.equal((await db.select().from(authSessionsTable).where(eq(authSessionsTable.userId, authUser.id))).length, 0);
    const replay = await call(base, "GET", "/api/me", { headers: { cookie: `wabista.session_token=${oldCookie}`, "x-forwarded-for": browser.ip } });
    assert.equal(replay.status, 401, "the old cookie no longer works");
  });

  test("an expired session is refused and cleared; a session older than a day is extended by 7 days", async () => {
    const browser = client();
    const email = newEmail("expiry");
    await browser.signUp(email);
    const authUser = (await authUserByEmail(email))!;

    const untouched = await browser.send("GET", "/api/me");
    assert.equal(untouched.status, 200);
    assert.ok(!untouched.setCookies.some((c) => c.startsWith("wabista.session_token=")), "a fresh session is not rewritten");

    await db.update(authSessionsTable).set({ expiresAt: sql`now() + interval '6 days' - interval '1 minute'` }).where(eq(authSessionsTable.userId, authUser.id));
    const refreshed = await browser.send("GET", "/api/me");
    assert.equal(refreshed.status, 200);
    const cookie = refreshed.setCookies.map(cookieAttributes).find((c) => c.name === "wabista.session_token");
    assert.ok(cookie, "the refreshed cookie is forwarded");
    assert.equal(cookie.attributes.get("max-age"), String(60 * 60 * 24 * 7));
    const [session] = await db.select().from(authSessionsTable).where(eq(authSessionsTable.userId, authUser.id));
    const days = (session!.expiresAt.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 6.99 && days <= 7.01, `expires in ${days} days`);

    await db.update(authSessionsTable).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(authSessionsTable.userId, authUser.id));
    const expired = await call(base, "GET", "/api/me", { headers: { cookie: `wabista.session_token=${browser.session}`, "x-forwarded-for": browser.ip } });
    assert.equal(expired.status, 401);
    assert.ok(expired.setCookies.some((c) => c.startsWith("wabista.session_token=") && /max-age=0/i.test(c)), "the dead cookie is cleared");
    assert.equal((await db.select().from(authSessionsTable).where(eq(authSessionsTable.userId, authUser.id))).length, 0);
  });
});

describe("origin and CSRF checks", () => {
  test("an untrusted origin, a missing origin with a cookie, and a cross-site navigation are refused", async () => {
    const email = newEmail("origin");
    const browser = client();
    await browser.signUp(email);
    const evil = await client().send("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD }, origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.code, "INVALID_ORIGIN");
    const noOrigin = await browser.send("POST", "/api/auth/sign-out", { body: {}, origin: null });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.json.code, "MISSING_OR_NULL_ORIGIN");
    const navigation = await client().send("POST", "/api/auth/sign-in/email", {
      body: { email, password: PASSWORD }, origin: null, headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
    });
    assert.equal(navigation.status, 403);
    assert.equal(navigation.json.code, "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED");
    assert.equal((await browser.send("GET", "/api/me")).status, 200, "the refused sign-out left the session alone");
  });

  test("only JSON or form bodies the API's own parsers consumed reach Better Auth; others are refused unread", async () => {
    const email = newEmail("body");
    // Over the 100 kb JSON limit: refused by the body parser (the generic error handler answers 500, as for
    // every other /api route).
    const big = await client().send("POST", "/api/auth/sign-up/email", { raw: JSON.stringify({ name: "x", email, password: PASSWORD, pad: "x".repeat(200 * 1024) }) });
    assert.equal(big.status, 500, big.text);
    const plain = await client().send("POST", "/api/auth/sign-up/email", { raw: `name=x&email=${email}`, contentType: "text/plain" });
    assert.equal(plain.status, 415);
    // Content types Better Auth would read as JSON but the API's JSON parser does not take (so no size limit
    // would apply): refused before a byte is read.
    const body = JSON.stringify({ name: "x", email, password: PASSWORD, pad: "x".repeat(512 * 1024) });
    for (const contentType of ["application/jsonx", "application/vnd.api+json", "application/json-patch+json"]) {
      const reply = await client().send("POST", "/api/auth/sign-up/email", { raw: body, contentType });
      assert.equal(reply.status, 415, `${contentType}: ${reply.text}`);
    }
    const signOut = await client().send("POST", "/api/auth/sign-out", { raw: body, contentType: "application/jsonx" });
    assert.equal(signOut.status, 415);
    assert.equal(await authUserByEmail(email), undefined, "nothing was created");
  });

  test("only the endpoints the app uses are served; anything else is 404 and leaves no rate-limit row", async () => {
    const probe = client();
    const paths: Array<[string, string]> = [
      ["POST", "/api/auth/update-user"], ["GET", "/api/auth/change-password"], ["POST", "/api/auth/change-password/"], ["POST", "/api/auth/change-email"],
      ["GET", "/api/auth/list-sessions"], ["POST", "/api/auth/revoke-sessions"], ["POST", "/api/auth/delete-user"],
      ["GET", "/api/auth/ok"], ["GET", "/api/auth/callback/github"], ["POST", "/api/auth/reset-password/abc"],
      ["POST", "/api/auth/request-password-reset"], ["POST", "/api/auth/sign-in/social"], ["GET", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/get-session"], ["POST", `/api/auth/garbage-${randomBytes(4).toString("hex")}`], ["POST", "/api/auth/sign-in/email/"],
    ];
    for (const [method, urlPath] of paths) {
      const reply = await probe.send(method, urlPath, method === "POST" ? { body: {} } : {});
      assert.equal(reply.status, 404, `${method} ${urlPath}: ${reply.status} ${reply.text}`);
    }
    const rows = await db.select().from(authRateLimitsTable).where(like(authRateLimitsTable.key, `${probe.ip}|%`));
    assert.deepEqual(rows, [], "unknown paths never reach Better Auth's limiter");
  });

  test("Better Auth acts on the path the guard checked: a crafted Host or X-Forwarded-Proto cannot redirect it", async () => {
    const ip = ips.next();
    const garbage = `garbage-${randomBytes(4).toString("hex")}`;
    const crafted: Array<Record<string, string>> = [
      { host: `app.example.com\\api\\auth\\${garbage}?` },
      { "x-forwarded-proto": `http://x/api/auth/${garbage}?` },
      { host: `x/api/auth/ok?` },
    ];
    for (const headers of crafted) {
      const reply = await call(base, "GET", "/api/auth/get-session", { headers: { ...headers, origin: ORIGIN, "x-forwarded-for": ip } });
      assert.equal(reply.status, 200, `${JSON.stringify(headers)}: ${reply.status} ${reply.text}`);
      assert.equal(reply.text, "null", "served as the session read it was checked as");
    }
    const rows = await db.select().from(authRateLimitsTable).where(like(authRateLimitsTable.key, `${ip}|%`));
    assert.deepEqual(rows, [], "no rate-limit row for a path the guard never admitted");
  });

  test("a sign-out without a body (Content-Length: 0) still signs out", async () => {
    const browser = client();
    const email = newEmail("bare-signout");
    await browser.signUp(email);
    const reply = await call(base, "POST", "/api/auth/sign-out", {
      headers: { origin: ORIGIN, cookie: `wabista.session_token=${browser.session}`, "content-length": "0", "x-forwarded-for": browser.ip },
    });
    assert.equal(reply.status, 200, reply.text);
    const authUser = (await authUserByEmail(email))!;
    assert.equal((await db.select().from(authSessionsTable).where(eq(authSessionsTable.userId, authUser.id))).length, 0);
  });
});

describe("database failures inside an auth endpoint", () => {
  test("reach the API's redacting error handler (500 JSON), never better-call's raw console.error", async () => {
    const email = newEmail("dbfail");
    assert.equal((await client().signUp(email)).status, 200);
    const proto = (pool as unknown as { Client: { prototype: { query: (...args: unknown[]) => unknown } } }).Client.prototype;
    const original = proto.query;
    const printed: unknown[][] = [];
    const originalConsoleError = console.error;
    let failed = 0;
    console.error = (...args: unknown[]) => { printed.push(args); };
    // Fail the session INSERT of a sign-in at the driver: Drizzle wraps it with the query and its bound values
    // (the new session token among them).
    proto.query = function (this: unknown, ...args: unknown[]) {
      const config = args[0] as string | { text?: string } | undefined;
      const text = typeof config === "string" ? config : config?.text;
      if (typeof text === "string" && /insert into "auth_sessions"/i.test(text)) {
        failed += 1;
        const error = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
        const callback = args.find((arg) => typeof arg === "function") as ((err: Error) => void) | undefined;
        if (callback) { process.nextTick(callback, error); return undefined; }
        return Promise.reject(error);
      }
      return original.apply(this, args);
    };
    let reply: Awaited<ReturnType<Client["signIn"]>>;
    try {
      reply = await client().signIn(email);
    } finally {
      proto.query = original;
      console.error = originalConsoleError;
    }
    assert.equal(failed, 1, "the session insert was attempted and failed");
    assert.equal(reply.status, 500);
    assert.deepEqual(reply.json, { error: "Internal server error" }, "answered by the API's error handler");
    assert.deepEqual(printed.map((args) => String(args[0]).slice(0, 80)), [], "nothing bypassed the redacting logger");
  });
});

describe("shared rate limit and log hygiene (second server process)", () => {
  const harnessDir = path.join(artifactDir, ".test-dist", "auth-serve-harness");
  const harnessPath = path.join(harnessDir, "serve-app.mjs");
  let child: ChildProcess;
  let childBase = "";
  let output = "";

  before(async () => {
    await rm(harnessDir, { recursive: true, force: true });
    await build({
      stdin: {
        contents: 'import app from "../src/app";\nconst server = app.listen(0, "127.0.0.1", () => console.log(`LISTENING ${server.address().port}`));\n',
        resolveDir: path.join(artifactDir, "test"),
        sourcefile: "serve-app.ts",
        loader: "ts",
      },
      outfile: harnessPath,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
      logLevel: "error",
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
    });
    child = spawn(process.execPath, [harnessPath], { cwd: artifactDir, env: { ...process.env, LOG_LEVEL: "debug" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    childBase = await new Promise<string>((resolve, reject) => {
      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match = /LISTENING (\d+)/.exec(output);
        if (match) resolve(`http://127.0.0.1:${match[1]}`);
      });
      child.once("exit", (code) => reject(new Error(`second server exited (${code}): ${output.slice(-2000)}`)));
    });
  });

  after(async () => {
    child.kill("SIGTERM");
    await rm(harnessDir, { recursive: true, force: true });
  });

  test("sign-in attempts are counted in the database: the 4th within 10 s gets 429 on EITHER process; other addresses are not affected", async () => {
    const email = newEmail("limit");
    await client().signUp(email);
    const attacker = client();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await attacker.signIn(email, `${PASSWORD}-wrong-${i}`)).status);
    assert.deepEqual(statuses, [401, 401, 401]);
    const onOtherProcess = new Client(() => childBase, attacker.ip, PASSWORD);
    const limited = await onOtherProcess.signIn(email);
    assert.equal(limited.status, 429, `the second process sees the same bucket (${limited.text})`);
    const retryAfter = limited.headers["x-retry-after"];
    assert.match(String(retryAfter), /^\d+$/, `numeric X-Retry-After (got ${retryAfter})`);
    assert.ok(Number(retryAfter) >= 0 && Number(retryAfter) <= 10);
    assert.equal((await attacker.signIn(email)).status, 429, "and the first process too");
    assert.equal((await client().signIn(email)).status, 200, "another address is not limited");
    const rows = await db.select().from(authRateLimitsTable).where(eq(authRateLimitsTable.key, `${attacker.ip}|/sign-in/email`));
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0]!.lastRequest, "number");

    const reader = client();
    await reader.signUp(newEmail("reader"));
    for (let i = 0; i < 5; i++) assert.equal((await reader.send("GET", "/api/auth/get-session")).status, 200);
    const sessionRows = await db.select().from(authRateLimitsTable).where(eq(authRateLimitsTable.key, `${reader.ip}|/get-session`));
    assert.equal(sessionRows.length, 0, "session reads are not rate-limit rows");
  });

  test("no password (current or new), session token, password hash or secret appears in the server's log output", async () => {
    const email = newEmail("logs");
    const browser = new Client(() => childBase, ips.next(), PASSWORD);
    assert.equal((await browser.signUp(email)).status, 200);
    assert.equal((await new Client(() => childBase, ips.next(), PASSWORD).signIn(email, `${PASSWORD}-nope`)).status, 401);
    const signedIn = new Client(() => childBase, ips.next(), PASSWORD);
    assert.equal((await signedIn.signIn(email)).status, 200);
    const signedInSession = signedIn.session!;
    assert.equal((await signedIn.send("GET", "/api/me")).status, 200);
    // Change password (its body carries the current and the new password; its reply carries a new session token).
    const changed = `${PASSWORD}-changed`;
    const changePassword = (body: object) => signedIn.send("POST", "/api/auth/change-password", { body });
    assert.equal((await changePassword({ currentPassword: `${PASSWORD}-nope`, newPassword: changed, revokeOtherSessions: true })).json?.code, "INVALID_PASSWORD");
    assert.equal((await changePassword({ currentPassword: PASSWORD, newPassword: changed })).json?.code, "REVOKE_OTHER_SESSIONS_REQUIRED");
    const passwordChanged = await changePassword({ currentPassword: PASSWORD, newPassword: changed, revokeOtherSessions: true });
    assert.equal(passwordChanged.status, 200, passwordChanged.text);
    const issuedToken = passwordChanged.json.token as string;
    const changedSession = signedIn.session!;
    assert.notEqual(changedSession, signedInSession);
    assert.equal((await signedIn.send("POST", "/api/auth/sign-out", { body: {} })).status, 200);
    // An invite preview carries its (acceptance) token in the URL: the request log must not record it.
    const inviteToken = randomBytes(16).toString("hex");
    const previewer = new Client(() => childBase, ips.next(), PASSWORD);
    assert.equal((await previewer.send("GET", `/api/invite-info/${inviteToken}`)).status, 404);
    // Express routes case-insensitively, and an unexpected failure is logged by the central error handler
    // (a NUL byte makes the database refuse the token: 500).
    assert.equal((await previewer.send("GET", `/api/Invite-Info/${inviteToken}`)).status, 404);
    assert.equal((await previewer.send("GET", `/api/invite-info/${inviteToken}%00`)).status, 500);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const authUser = (await authUserByEmail(email))!;
    const [account] = await db.select().from(authAccountsTable).where(eq(authAccountsTable.userId, authUser.id));
    const tokens = [browser.session!, signedInSession, changedSession, issuedToken,
      ...[browser.session!, signedInSession, changedSession].map((cookie) => decodeURIComponent(cookie).split(".")[0]!)];
    assert.ok(tokens.every((t) => t.length > 20), "real token values are checked");
    assert.ok(output.length > 0, "the server logged something");
    assert.match(output, /\/api\/auth\/sign-in\/email/, "requests were logged");
    assert.match(output, /\/api\/invite-info\//, "the preview request was logged");
    assert.match(output, /\/api\/auth\/change-password/, "the change-password requests were logged");
    for (const [label, value] of [["password", PASSWORD], ["new password", changed], ["password hash", account!.password!], ["secret", SECRET], ["invitation token", inviteToken], ...tokens.map((t) => ["session token", t])] as const) {
      assert.ok(!output.includes(value), `the ${label} must not be logged`);
    }
  });
});
