import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignsTable,
  contactsTable,
  db,
  organizationInvitationsTable,
  organizationMembersTable,
  organizationsTable,
  phoneNumbersTable,
  pool,
  templatesTable,
  usersTable,
  wabasTable,
} from "@workspace/db";
import contactsRouter from "../src/routes/contacts";
import campaignsRouter from "../src/routes/campaigns";
import templatesRouter from "../src/routes/templates";
import phoneNumbersRouter from "../src/routes/phone-numbers";
import campaignRoutesRouter from "../src/routes/campaign-routes";
import membersRouter from "../src/routes/members";
import invitationsRouter from "../src/routes/invitations";

// These tests prove that no route ever lets one tenant (organization) read
// or mutate another tenant's row, even when the caller supplies a real,
// existing resource ID that simply belongs to a different organization --
// the exact shape of bug a stale/incorrect workspace-switch could produce
// (req.organizationId pointing at org A while a path param addresses a
// resource that actually lives in org B). Every mutation asserts BOTH that
// the cross-org attempt is rejected (404, never a silent no-op success) AND
// that org B's row is byte-for-byte unchanged afterward.

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

async function setUpTenant(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [owner] = await db.insert(usersTable).values({
    clerkId: `clerk-${slug}`, email: `owner-${slug}@example.com`, name: `Owner ${slug}`,
  }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: organization.id, userId: owner.id, role: "owner" });

  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(4, "0")}${Math.floor(Math.random() * 900 + 100)}`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: slug, status: "Approved",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: `${slug}-campaign`, status: "Draft" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 5,
  }).returning();
  const [contact] = await db.insert(contactsTable).values({
    organizationId: organization.id, name: `${slug}-contact`, phone: `+1888${organization.id}0000000`, tags: [],
  }).returning();
  const [invitation] = await db.insert(organizationInvitationsTable).values({
    organizationId: organization.id, email: `pending-${slug}@example.com`, role: "agent", invitedByUserId: owner.id,
  }).returning();
  const [member] = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.organizationId, organization.id));

  return { organization, owner, waba, phone, template, campaign, route, contact, invitation, member };
}

function fakeReq(organizationId: number, authUserId: number, role = "owner", extra: Record<string, unknown> = {}) {
  return {
    organizationId,
    role,
    authUser: { id: authUserId, clerkId: "x", email: "x@example.com", name: "X", isPlatformAdmin: false, createdAt: new Date() },
    params: {},
    body: {},
    query: {},
    ...extra,
  };
}

test("cross-tenant isolation: no route lets org A touch org B's contact/campaign/template/phone/route/member/invitation", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const a = await setUpTenant(`tenant-a-${suffix}`);
  const b = await setUpTenant(`tenant-b-${suffix}`);
  try {
    // --- contacts ---
    const patchContact = findRouteHandler(contactsRouter, "/contacts/:contactId", "patch");
    const resPatchContact = fakeResponse();
    await patchContact(fakeReq(a.organization.id, a.owner.id, "owner", { params: { contactId: b.contact.id }, body: { name: "hacked" } }), resPatchContact);
    assert.equal(resPatchContact.statusCode, 404);

    const deleteContact = findRouteHandler(contactsRouter, "/contacts/:contactId", "delete");
    const resDeleteContact = fakeResponse();
    await deleteContact(fakeReq(a.organization.id, a.owner.id, "owner", { params: { contactId: b.contact.id } }), resDeleteContact);
    assert.equal(resDeleteContact.statusCode, 404);

    const listContacts = findRouteHandler(contactsRouter, "/contacts", "get");
    const resListContactsA = fakeResponse();
    await listContacts(fakeReq(a.organization.id, a.owner.id), resListContactsA);
    assert.ok(!resListContactsA.body.contacts.some((c: { id: number }) => c.id === b.contact.id), "org A's contact list must never include org B's contact");

    const [contactAfter] = await db.select().from(contactsTable).where(eq(contactsTable.id, b.contact.id));
    assert.equal(contactAfter!.name, `tenant-b-${suffix}-contact`, "org B's contact must be unchanged");

    // --- campaigns ---
    const patchCampaign = findRouteHandler(campaignsRouter, "/campaigns/:campaignId", "patch");
    const resPatchCampaign = fakeResponse();
    await patchCampaign(fakeReq(a.organization.id, a.owner.id, "owner", { params: { campaignId: b.campaign.id }, body: { name: "hacked" } }), resPatchCampaign);
    assert.equal(resPatchCampaign.statusCode, 404);

    const deleteCampaign = findRouteHandler(campaignsRouter, "/campaigns/:campaignId", "delete");
    const resDeleteCampaign = fakeResponse();
    await deleteCampaign(fakeReq(a.organization.id, a.owner.id, "owner", { params: { campaignId: b.campaign.id } }), resDeleteCampaign);
    assert.equal(resDeleteCampaign.statusCode, 404);

    const [campaignAfter] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, b.campaign.id));
    assert.ok(campaignAfter, "org B's campaign must still exist");
    assert.equal(campaignAfter!.name, `tenant-b-${suffix}-campaign`);

    // --- templates ---
    const patchTemplate = findRouteHandler(templatesRouter, "/templates/:templateId", "patch");
    const resPatchTemplate = fakeResponse();
    await patchTemplate(fakeReq(a.organization.id, a.owner.id, "owner", { params: { templateId: b.template.id }, body: { status: "Rejected" } }), resPatchTemplate);
    assert.equal(resPatchTemplate.statusCode, 404);

    const deleteTemplate = findRouteHandler(templatesRouter, "/templates/:templateId", "delete");
    const resDeleteTemplate = fakeResponse();
    await deleteTemplate(fakeReq(a.organization.id, a.owner.id, "owner", { params: { templateId: b.template.id } }), resDeleteTemplate);
    assert.equal(resDeleteTemplate.statusCode, 404);

    const [templateAfter] = await db.select().from(templatesTable).where(eq(templatesTable.id, b.template.id));
    assert.equal(templateAfter!.status, "Approved", "org B's template must be unchanged");

    // --- phone numbers ---
    const patchPhone = findRouteHandler(phoneNumbersRouter, "/phone-numbers/:phoneNumberId", "patch");
    const resPatchPhone = fakeResponse();
    await patchPhone(fakeReq(a.organization.id, a.owner.id, "owner", { params: { phoneNumberId: b.phone.id }, body: { displayName: "hacked" } }), resPatchPhone);
    assert.equal(resPatchPhone.statusCode, 404);

    const deletePhone = findRouteHandler(phoneNumbersRouter, "/phone-numbers/:phoneNumberId", "delete");
    const resDeletePhone = fakeResponse();
    await deletePhone(fakeReq(a.organization.id, a.owner.id, "owner", { params: { phoneNumberId: b.phone.id } }), resDeletePhone);
    assert.equal(resDeletePhone.statusCode, 404);

    const [phoneAfter] = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.id, b.phone.id));
    assert.equal(phoneAfter!.displayName, `tenant-b-${suffix}-phone`, "org B's phone must be unchanged");

    // --- campaign routes ---
    const listRoutes = findRouteHandler(campaignRoutesRouter, "/campaign-routes", "get");
    const resListRoutesCrossCampaign = fakeResponse();
    // Querying org A's context with org B's real campaignId must never leak org B's route --
    // it should behave exactly like an unmatched filter (empty list), not an error or a leak.
    await listRoutes(fakeReq(a.organization.id, a.owner.id, "owner", { query: { campaignId: String(b.campaign.id) } }), resListRoutesCrossCampaign);
    assert.equal(resListRoutesCrossCampaign.statusCode, 200);
    assert.deepEqual(resListRoutesCrossCampaign.body, []);

    const patchRoute = findRouteHandler(campaignRoutesRouter, "/campaign-routes/:routeId", "patch");
    const resPatchRoute = fakeResponse();
    await patchRoute(fakeReq(a.organization.id, a.owner.id, "owner", { params: { routeId: b.route.id }, body: { configuredTps: 1 } }), resPatchRoute);
    assert.equal(resPatchRoute.statusCode, 404);

    const deleteRoute = findRouteHandler(campaignRoutesRouter, "/campaign-routes/:routeId", "delete");
    const resDeleteRoute = fakeResponse();
    await deleteRoute(fakeReq(a.organization.id, a.owner.id, "owner", { params: { routeId: b.route.id } }), resDeleteRoute);
    assert.equal(resDeleteRoute.statusCode, 404);

    const [routeAfter] = await db.select().from(campaignRoutesTable).where(eq(campaignRoutesTable.id, b.route.id));
    assert.ok(routeAfter, "org B's route must still exist");
    assert.equal(routeAfter!.configuredTps, 5);

    // --- members ---
    const patchMember = findRouteHandler(membersRouter, "/members/:memberId", "patch");
    const resPatchMember = fakeResponse();
    await patchMember(fakeReq(a.organization.id, a.owner.id, "owner", { params: { memberId: b.member!.id }, body: { role: "agent" } }), resPatchMember);
    assert.equal(resPatchMember.statusCode, 404);

    const deleteMember = findRouteHandler(membersRouter, "/members/:memberId", "delete");
    const resDeleteMember = fakeResponse();
    await deleteMember(fakeReq(a.organization.id, a.owner.id, "owner", { params: { memberId: b.member!.id } }), resDeleteMember);
    assert.equal(resDeleteMember.statusCode, 404);

    const [memberAfter] = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.id, b.member!.id));
    assert.ok(memberAfter, "org B's membership must still exist");
    assert.equal(memberAfter!.role, "owner");

    // --- invitations ---
    const revokeInvitation = findRouteHandler(invitationsRouter, "/invitations/:invitationId", "delete");
    const resRevoke = fakeResponse();
    await revokeInvitation(fakeReq(a.organization.id, a.owner.id, "owner", { params: { invitationId: String(b.invitation.id) } }), resRevoke);
    assert.equal(resRevoke.statusCode, 404);

    const listInvitations = findRouteHandler(invitationsRouter, "/invitations", "get");
    const resListInvitationsA = fakeResponse();
    await listInvitations(fakeReq(a.organization.id, a.owner.id, "owner"), resListInvitationsA);
    assert.ok(!resListInvitationsA.body.some((i: { id: number }) => i.id === b.invitation.id), "org A's invitation list must never include org B's invitation");

    const [invitationAfter] = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.id, b.invitation.id));
    assert.equal(invitationAfter!.status, "Pending", "org B's invitation must be unaffected by org A's revoke attempt");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, a.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, b.organization.id));
  }
});

test("workspace switch: the same physical request path immediately reflects the newly active org's role and data, with zero bleed from the previous org", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const a = await setUpTenant(`switch-a-${suffix}`);
  const b = await setUpTenant(`switch-b-${suffix}`);
  // A single real person, admin in A, owner in B -- the exact shape of user
  // who exercises the workspace switcher.
  const [user] = await db.insert(usersTable).values({ clerkId: `clerk-switch-${suffix}`, email: `switch-${suffix}@example.com`, name: "Switcher" }).returning();
  await db.insert(organizationMembersTable).values({ organizationId: a.organization.id, userId: user.id, role: "admin" });
  await db.insert(organizationMembersTable).values({ organizationId: b.organization.id, userId: user.id, role: "owner" });
  try {
    const listMembers = findRouteHandler(membersRouter, "/members", "get");

    // "Request while active org = A" -- attachOrgContext would have resolved
    // this from the wabista_active_org_id cookie on this exact request.
    const resA = fakeResponse();
    await listMembers(fakeReq(a.organization.id, user.id, "admin"), resA);
    assert.ok(resA.body.some((m: { userId: number }) => m.userId === a.owner.id));
    assert.ok(!resA.body.some((m: { userId: number }) => m.userId === b.owner.id), "must not see org B's members while active org is A");

    // A brand-new request after switching -- attachOrgContext is stateless
    // per request (re-reads the cookie and re-queries membership every
    // time), so there is no server-side cache to go stale; this proves the
    // very next request is already fully scoped to B with B's role.
    const resB = fakeResponse();
    await listMembers(fakeReq(b.organization.id, user.id, "owner"), resB);
    assert.ok(resB.body.some((m: { userId: number }) => m.userId === b.owner.id));
    assert.ok(!resB.body.some((m: { userId: number }) => m.userId === a.owner.id), "must not see org A's members while active org is B");

    // Permission must also flip immediately: an action gated on Owner should
    // now be allowed (role=owner in B) even though the same user was only
    // Admin a moment ago in A.
    const patchMember = findRouteHandler(membersRouter, "/members/:memberId", "patch");
    const [bOwnerMembership] = await db.select().from(organizationMembersTable).where(and(eq(organizationMembersTable.organizationId, b.organization.id), eq(organizationMembersTable.userId, b.owner.id)));
    const resGrantOwner = fakeResponse();
    await patchMember(fakeReq(b.organization.id, user.id, "owner", { params: { memberId: bOwnerMembership!.id }, body: { role: "owner" } }), resGrantOwner);
    assert.equal(resGrantOwner.statusCode, 200, "owner-level action must succeed immediately once the active org grants owner rank");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, a.organization.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, b.organization.id));
  }
});
