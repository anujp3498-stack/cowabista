import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  organizationInvitationsTable,
  organizationMembersTable,
  organizationsTable,
  pool,
  usersTable,
} from "@workspace/db";
import { authUserLinksTable, authUsersTable } from "@workspace/db/auth";
import { acceptPendingInvitations } from "../src/lib/orgProvisioning";
import membersRouter from "../src/routes/members";
import invitationsRouter from "../src/routes/invitations";

// These tests prove people can join a team before they ever sign up: an
// admin invites an email with no account yet (a Pending invitation is
// created instead of a 404). Since the Better Auth move (decision D1) the
// invitee joins with the invite link while signed in with that email
// (POST /invitations/accept, covered over HTTP in invitation-accept.test.ts);
// acceptPendingInvitations (email match) is only used by attachOrgContext
// for accounts whose email is verified, and its function contract is pinned
// here.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRouteHandler(router: any, path: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler registered for ${method.toUpperCase()} ${path}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.send = (body?: unknown) => { res.body = body; return res; };
  return res;
}

after(async () => {
  await pool.end();
});

async function createOrgWithOwner(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [owner] = await db.insert(usersTable).values({
    clerkId: `clerk-${slug}-owner`, email: `owner-${slug}@example.com`, name: "Owner",
  }).returning();
  await db.insert(organizationMembersTable).values({
    organizationId: organization.id, userId: owner.id, role: "owner",
  });
  return { organization, owner };
}

function inviteHandlerReq(organizationId: number, ownerId: number, ownerName: string, role: string, body: Record<string, unknown>) {
  return {
    body,
    organizationId,
    role,
    authUser: { id: ownerId, email: "owner@example.com", name: ownerName, isPlatformAdmin: false, createdAt: new Date() },
  };
}

test("inviting an email with no account creates a Pending invitation, not a 404", async () => {
  const slug = `invite-noaccount-${process.pid}-${Date.now()}`;
  const { organization, owner } = await createOrgWithOwner(slug);
  try {
    const handler = findRouteHandler(membersRouter, "/members", "post");
    const req = inviteHandlerReq(organization.id, owner.id, "Owner", "owner", { email: `NewPerson-${slug}@Example.com`, role: "manager" });
    const res = fakeResponse();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.ok(res.body.invitation, "expected an invitation, not a member, for an unknown email");
    assert.equal(res.body.member, undefined);
    assert.equal(res.body.invitation.email, `newperson-${slug}@example.com`.toLowerCase());
    assert.equal(res.body.invitation.role, "manager");
    assert.equal(res.body.invitation.status, "Pending");

    const [row] = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.organizationId, organization.id));
    assert.ok(row);
    assert.equal(row.email, `newperson-${slug}@example.com`.toLowerCase());
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("inviting the same unknown email twice refreshes the one Pending invitation instead of erroring or duplicating", async () => {
  const slug = `invite-refresh-${process.pid}-${Date.now()}`;
  const { organization, owner } = await createOrgWithOwner(slug);
  try {
    const handler = findRouteHandler(membersRouter, "/members", "post");
    const email = `person-${slug}@example.com`;

    await handler(inviteHandlerReq(organization.id, owner.id, "Owner", "owner", { email, role: "agent" }), fakeResponse());
    const res2 = fakeResponse();
    await handler(inviteHandlerReq(organization.id, owner.id, "Owner", "owner", { email, role: "admin" }), res2);

    assert.equal(res2.body.invitation.role, "admin");
    const rows = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.organizationId, organization.id));
    assert.equal(rows.length, 1, "must not create a second Pending row for the same email");
    assert.equal(rows[0]!.role, "admin");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("acceptPendingInvitations matches the invited email case-insensitively and joins the invited org(s), marking invitations Accepted", async () => {
  const slug = `accept-${process.pid}-${Date.now()}`;
  const { organization, owner } = await createOrgWithOwner(slug);
  const { organization: secondOrg, owner: secondOwner } = await createOrgWithOwner(`${slug}-2`);
  try {
    await db.insert(organizationInvitationsTable).values([
      { organizationId: organization.id, email: `invitee-${slug}@example.com`, role: "manager", invitedByUserId: owner.id },
      { organizationId: secondOrg.id, email: `invitee-${slug}@example.com`, role: "agent", invitedByUserId: secondOwner.id },
    ]);

    // Signup happens with different casing than the invite -- must still match.
    const [newUser] = await db.insert(usersTable).values({
      clerkId: `clerk-${slug}-invitee`, email: `Invitee-${slug}@Example.com`, name: "Invitee",
    }).returning();

    const memberships = await acceptPendingInvitations(newUser);
    assert.equal(memberships.length, 2);
    assert.deepEqual(memberships.map((m) => m.organizationId).sort(), [organization.id, secondOrg.id].sort());

    const membershipRows = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, newUser.id));
    assert.equal(membershipRows.length, 2);
    assert.ok(membershipRows.some((m) => m.organizationId === organization.id && m.role === "manager"));
    assert.ok(membershipRows.some((m) => m.organizationId === secondOrg.id && m.role === "agent"));

    const invitationRows = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.email, `invitee-${slug}@example.com`));
    assert.ok(invitationRows.every((i) => i.status === "Accepted"));
    assert.ok(invitationRows.every((i) => i.acceptedByUserId === newUser.id));

    // Calling it again (e.g. a second login) must be a no-op: nothing left Pending.
    const second = await acceptPendingInvitations(newUser);
    assert.equal(second.length, 0);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, secondOrg.id));
  }
});

// Contract changed on purpose with the Better Auth move (D1): Clerk verified
// email ownership, so an existing account used to be added immediately.
// Email/password sign-up does not verify the address, so only an account
// whose email is verified is still added immediately; any other existing
// account (unverified, or a legacy row) gets a pending invitation.
test("inviting an existing account: added immediately only when its email is verified, otherwise a pending invitation", async () => {
  const slug = `invite-existing-${process.pid}-${Date.now()}`;
  const { organization, owner } = await createOrgWithOwner(slug);
  const authIds: string[] = [];
  const linkedUser = async (label: string, emailVerified: boolean) => {
    const email = `${label}-${slug}@example.com`;
    const authId = `test-${label}-${slug}`;
    authIds.push(authId);
    await db.insert(authUsersTable).values({ id: authId, name: label, email, emailVerified });
    const [user] = await db.insert(usersTable).values({ clerkId: `better-auth:${authId}`, email, name: label }).returning();
    await db.insert(authUserLinksTable).values({ authUserId: authId, userId: user!.id });
    return user!;
  };
  try {
    const handler = findRouteHandler(membersRouter, "/members", "post");
    const invite = async (email: string) => {
      const res = fakeResponse();
      await handler(inviteHandlerReq(organization.id, owner.id, "Owner", "owner", { email, role: "agent" }), res);
      return res;
    };

    const verified = await linkedUser("verified", true);
    const added = await invite(`Verified-${slug}@Example.com`);
    assert.equal(added.statusCode, 201);
    assert.ok(added.body.member, "a verified account is added immediately");
    assert.equal(added.body.invitation, undefined);
    assert.equal(added.body.member.userId, verified.id);

    await linkedUser("unverified", false);
    const [legacy] = await db.insert(usersTable).values({
      clerkId: `clerk-${slug}-existing`, email: `existing-${slug}@example.com`, name: "Existing",
    }).returning();
    for (const email of [`unverified-${slug}@example.com`, `Existing-${slug}@Example.com`]) {
      const res = await invite(email);
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.member, undefined, `${email} must not be added without a verified email`);
      assert.equal(res.body.invitation.status, "Pending");
      assert.equal(res.body.invitation.email, email.toLowerCase());
    }
    const members = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.organizationId, organization.id));
    assert.ok(!members.some((m) => m.userId === legacy!.id), "the legacy account was not added");

    const again = await invite(`verified-${slug}@example.com`);
    assert.equal(again.statusCode, 409, "an existing member is still refused");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
    for (const id of authIds) await db.delete(authUsersTable).where(eq(authUsersTable.id, id));
  }
});

test("every invite gets a unique shareable token, and /invite-info/:token exposes only the safe preview fields -- without granting membership itself", async () => {
  const slug = `invite-link-${process.pid}-${Date.now()}`;
  const { organization, owner } = await createOrgWithOwner(slug);
  try {
    const inviteHandler = findRouteHandler(membersRouter, "/members", "post");
    const res = fakeResponse();
    await inviteHandler(
      inviteHandlerReq(organization.id, owner.id, "Owner", "owner", {
        email: `linked-${slug}@example.com`,
        role: "manager",
      }),
      res,
    );
    const token: string = res.body.invitation.token;
    assert.ok(token && token.length > 10, "invite response must include a usable token");

    // Re-inviting the same still-pending email rotates the token, so an
    // old copied/leaked link stops resolving to the current invite state.
    const res2 = fakeResponse();
    await inviteHandler(
      inviteHandlerReq(organization.id, owner.id, "Owner", "owner", {
        email: `linked-${slug}@example.com`,
        role: "admin",
      }),
      res2,
    );
    const rotatedToken: string = res2.body.invitation.token;
    assert.notEqual(rotatedToken, token, "re-inviting must rotate the token");

    const previewHandler = findRouteHandler(invitationsRouter, "/invite-info/:token", "get");

    const notFound = fakeResponse();
    await previewHandler({ params: { token: "does-not-exist" } }, notFound);
    assert.equal(notFound.statusCode, 404);

    const stale = fakeResponse();
    await previewHandler({ params: { token } }, stale);
    assert.equal(stale.statusCode, 404, "the rotated-away token must no longer resolve");

    const preview = fakeResponse();
    await previewHandler({ params: { token: rotatedToken } }, preview);
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.body.organizationName, slug);
    assert.equal(preview.body.role, "admin");
    assert.equal(preview.body.email, `linked-${slug}@example.com`);
    assert.equal(preview.body.status, "Pending");
    assert.equal(Object.keys(preview.body).length, 4, "preview must not leak fields beyond org/role/email/status");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("only an Owner can revoke a pending Owner-role invitation; admin/owner can revoke others, and revoked invitations are excluded from the pending list", async () => {
  const slug = `revoke-${process.pid}-${Date.now()}`;
  const { organization, owner } = await createOrgWithOwner(slug);
  try {
    const [ownerInvite] = await db.insert(organizationInvitationsTable).values({
      organizationId: organization.id, email: `future-owner-${slug}@example.com`, role: "owner", invitedByUserId: owner.id,
    }).returning();
    const [agentInvite] = await db.insert(organizationInvitationsTable).values({
      organizationId: organization.id, email: `future-agent-${slug}@example.com`, role: "agent", invitedByUserId: owner.id,
    }).returning();

    const revokeHandler = findRouteHandler(invitationsRouter, "/invitations/:invitationId", "delete");
    const listHandler = findRouteHandler(invitationsRouter, "/invitations", "get");

    // An admin (not owner) may not revoke an Owner-role invitation.
    const forbidden = fakeResponse();
    await revokeHandler({ params: { invitationId: String(ownerInvite.id) }, organizationId: organization.id, role: "admin" }, forbidden);
    assert.equal(forbidden.statusCode, 403);

    // But an admin can revoke a non-Owner invitation.
    const ok = fakeResponse();
    await revokeHandler({ params: { invitationId: String(agentInvite.id) }, organizationId: organization.id, role: "admin" }, ok);
    assert.equal(ok.statusCode, 204);

    // The owner can revoke the Owner-role invitation.
    const ownerRevoke = fakeResponse();
    await revokeHandler({ params: { invitationId: String(ownerInvite.id) }, organizationId: organization.id, role: "owner" }, ownerRevoke);
    assert.equal(ownerRevoke.statusCode, 204);

    const listRes = fakeResponse();
    await listHandler({ organizationId: organization.id, role: "owner" }, listRes);
    assert.deepEqual(listRes.body, [], "revoked invitations must not appear in the pending list");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});
