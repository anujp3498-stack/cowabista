// Token-bound invitation acceptance (decision D1) over real HTTP on the disposable local database. Better Auth
// email/password sign-up does not verify email ownership, so signing up with an invited address must never
// join that workspace by itself; the invitee joins only with POST /invitations/accept, holding the token AND
// signed in with the invited email. Everything created here is removed at the end.
import { randomBytes, randomUUID } from "node:crypto";

process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
process.env.BETTER_AUTH_URL = "http://localhost:24902";
process.env.CORS_ALLOWED_ORIGINS = "";
process.env.TRUST_PROXY = "1";

import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  db,
  organizationInvitationsTable,
  organizationMembersTable,
  organizationsTable,
  pool,
  settlementPool,
  usersTable,
} from "@workspace/db";
import { authRateLimitsTable, authUserLinksTable, authUsersTable } from "@workspace/db/auth";
import { Client, ipAllocator } from "./auth-http-fixtures";

const RUN = randomBytes(3).toString("hex");
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
const ips = ipAllocator();
const emails: string[] = [];
const newEmail = (label: string) => { const email = `invite-${label}-${RUN}-${emails.length}@example.test`; emails.push(email); return email; };
const orgIds: number[] = [];

let server: Server;
let base = "";
const client = () => new Client(() => base, ips.next(), PASSWORD);

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
    orgIds.push(...owned.map((o) => o.organizationId));
  }
  if (orgIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(usersTable).where(like(usersTable.clerkId, `invite-owner-${RUN}-%`));
  if (authUsers.length) await db.delete(authUsersTable).where(inArray(authUsersTable.id, authUsers.map((u) => u.id)));
  await db.delete(authRateLimitsTable).where(like(authRateLimitsTable.key, `${ips.block}.%`));
  await Promise.all([pool.end(), settlementPool.end()]);
});

/** A team workspace with an owner (a local user only; it never signs in here). */
async function team(label: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: `Team ${label}`, slug: `team-${label}-${RUN}-${randomBytes(2).toString("hex")}` }).returning();
  orgIds.push(organization!.id);
  const [owner] = await db.insert(usersTable).values({ clerkId: `invite-owner-${RUN}-${label}`, email: `owner-${label}-${RUN}@example.test`, name: "Owner" }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: organization!.id, userId: owner!.id, role: "owner" });
  return { organization: organization!, owner: owner! };
}

async function invite(organizationId: number, invitedBy: number, email: string, role: "owner" | "admin" | "manager" | "agent" = "manager") {
  const [invitation] = await db.insert(organizationInvitationsTable).values({ organizationId, email, role, invitedByUserId: invitedBy, token: randomUUID() }).returning();
  return invitation!;
}

async function invitationRow(id: number) {
  const [row] = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.id, id));
  return row!;
}

async function membershipsOf(email: string) {
  const [authUser] = await db.select().from(authUsersTable).where(eq(authUsersTable.email, email));
  if (!authUser) return [];
  const [link] = await db.select().from(authUserLinksTable).where(eq(authUserLinksTable.authUserId, authUser.id));
  if (!link) return [];
  return db.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, link.userId));
}

const accept = (browser: Client, token: unknown) => browser.send("POST", "/api/invitations/accept", { body: { token } });

test("signing up with an invited email does NOT join the workspace: a personal workspace is created and the invitation stays Pending", async () => {
  const { organization, owner } = await team("nojoin");
  const email = newEmail("nojoin");
  const invitation = await invite(organization.id, owner.id, email, "owner");
  const browser = client();
  assert.equal((await browser.signUp(email)).status, 200);
  const me = await browser.send("GET", "/api/organizations");
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.map((o: { id: number }) => o.id).includes(organization.id), false, "not a member of the inviting workspace");
  assert.equal(me.json.length, 1);
  assert.equal(me.json[0].role, "owner", "their own personal workspace");
  assert.equal((await invitationRow(invitation.id)).status, "Pending");
});

test("token + matching email joins with the invited role as the first API call (no personal workspace) and makes it active", async () => {
  const { organization, owner } = await team("join");
  const email = newEmail("join");
  const invitation = await invite(organization.id, owner.id, email, "admin");
  const browser = client();
  await browser.signUp(email.toUpperCase());
  const reply = await accept(browser, invitation.token);
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(reply.json, { organizationId: organization.id, role: "admin" });
  assert.equal(browser.cookies.get("wabista_active_org_id"), String(organization.id), "the joined workspace becomes active");
  const row = await invitationRow(invitation.id);
  assert.equal(row.status, "Accepted");
  assert.ok(row.acceptedAt);
  const memberships = await membershipsOf(email);
  assert.equal(memberships.length, 1, "no personal workspace was provisioned first");
  assert.equal(row.acceptedByUserId, memberships[0]!.userId);
  const orgs = await browser.send("GET", "/api/organizations");
  assert.deepEqual(orgs.json.map((o: { id: number; role: string; isActive: boolean }) => [o.id, o.role, o.isActive]), [[organization.id, "admin", true]]);

  const again = await accept(browser, invitation.token);
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "invitation_not_pending");
  assert.equal((await membershipsOf(email)).length, 1);
});

test("a token held by someone signed in with another email is refused and leaves the invitation untouched", async () => {
  const { organization, owner } = await team("mismatch");
  const invitation = await invite(organization.id, owner.id, newEmail("invitee"), "owner");
  const intruder = client();
  const intruderEmail = newEmail("intruder");
  await intruder.signUp(intruderEmail);
  const reply = await accept(intruder, invitation.token);
  assert.equal(reply.status, 403);
  assert.equal(reply.json.code, "invitation_email_mismatch");
  assert.equal((await invitationRow(invitation.id)).status, "Pending");
  assert.ok(!(await membershipsOf(intruderEmail)).some((m) => m.organizationId === organization.id));
});

test("unknown, revoked and already-accepted tokens, a missing token and an anonymous caller are refused", async () => {
  const { organization, owner } = await team("refusals");
  const email = newEmail("refusals");
  const revoked = await invite(organization.id, owner.id, email);
  await db.update(organizationInvitationsTable).set({ status: "Revoked" }).where(eq(organizationInvitationsTable.id, revoked.id));
  const browser = client();
  await browser.signUp(email);
  const unknown = await accept(browser, randomUUID());
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, "invitation_not_found");
  const revokedReply = await accept(browser, revoked.token);
  assert.equal(revokedReply.status, 409);
  assert.equal(revokedReply.json.code, "invitation_not_pending");
  for (const token of [undefined, "", "x".repeat(201), 42]) {
    assert.equal((await accept(browser, token)).status, 400, `token ${JSON.stringify(token)}`);
  }
  const anonymous = await client().send("POST", "/api/invitations/accept", { body: { token: revoked.token } });
  assert.equal(anonymous.status, 401);
  assert.ok(!(await membershipsOf(email)).some((m) => m.organizationId === organization.id));
});

test("two concurrent accepts of one invitation create one membership", async () => {
  const { organization, owner } = await team("race");
  const email = newEmail("race");
  const invitation = await invite(organization.id, owner.id, email, "agent");
  const browser = client();
  await browser.signUp(email);
  const replies = await Promise.all([accept(browser, invitation.token), accept(browser, invitation.token), accept(browser, invitation.token)]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409, 409]);
  const memberships = (await membershipsOf(email)).filter((m) => m.organizationId === organization.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]!.role, "agent");
});

test("an existing member keeps their role when accepting; an owner invitation grants owner", async () => {
  const { organization, owner } = await team("roles");
  const email = newEmail("roles");
  const browser = client();
  await browser.signUp(email);
  const first = await accept(browser, (await invite(organization.id, owner.id, email, "manager")).token);
  assert.equal(first.json.role, "manager");
  const second = await accept(browser, (await invite(organization.id, owner.id, email, "owner")).token);
  assert.equal(second.status, 200);
  assert.equal(second.json.role, "manager", "an existing membership is not changed by a later invitation");

  const { organization: other, owner: otherOwner } = await team("owner-role");
  const ownerInvite = await accept(browser, (await invite(other.id, otherOwner.id, email, "owner")).token);
  assert.deepEqual(ownerInvite.json, { organizationId: other.id, role: "owner" });
});

test("someone removed from every workspace with a Pending invitation for their email is not auto-joined", async () => {
  const { organization, owner } = await team("removed");
  const email = newEmail("removed");
  const browser = client();
  await browser.signUp(email);
  assert.equal((await browser.send("GET", "/api/me")).status, 200);
  const before = await membershipsOf(email);
  assert.equal(before.length, 1);
  await db.delete(organizationMembersTable).where(eq(organizationMembersTable.userId, before[0]!.userId));
  const invitation = await invite(organization.id, owner.id, email);
  assert.equal((await browser.send("GET", "/api/me")).status, 200);
  const after = await membershipsOf(email);
  assert.equal(after.length, 1);
  assert.notEqual(after[0]!.organizationId, organization.id, "a fresh personal workspace, not the inviting one");
  orgIds.push(after[0]!.organizationId, before[0]!.organizationId);
  assert.equal((await invitationRow(invitation.id)).status, "Pending");
});

test("POST /members for an existing unverified account creates a pending invitation, which that account then accepts", async () => {
  const admin = client();
  await admin.signUp(newEmail("admin"));
  const adminOrg = (await admin.send("GET", "/api/organizations")).json[0].id as number;
  const email = newEmail("member");
  const member = client();
  await member.signUp(email);
  await member.send("GET", "/api/me");
  const invited = await admin.send("POST", "/api/members", { body: { email, role: "manager" } });
  assert.equal(invited.status, 201, invited.text);
  assert.equal(invited.json.member, undefined, "not added directly: the email is not verified");
  assert.equal(invited.json.invitation.status, "Pending");
  const joined = await accept(member, invited.json.invitation.token);
  assert.deepEqual(joined.json, { organizationId: adminOrg, role: "manager" });
});
