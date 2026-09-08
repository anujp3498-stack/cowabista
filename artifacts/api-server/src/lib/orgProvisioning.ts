import { and, eq, sql } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignsTable,
  contactsTable,
  db,
  organizationInvitationsTable,
  organizationMembersTable,
  organizationsTable,
  phoneNumbersTable,
  templatesTable,
  wabasTable,
  type OrganizationRole,
  type User,
} from "@workspace/db";

/** A transaction handle, as passed to `db.transaction(async (tx) => ...)`. */
type DbTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/** Anything with the same query-builder surface as `db`, including a transaction handle. */
type DbClient = typeof db | DbTransaction;

function slugify(base: string): string {
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${cleaned || "workspace"}-${suffix}`;
}

/**
 * Seeds a small, clearly-labeled set of demo records ("(Sample)" suffix,
 * isSample=true) so a brand-new organization is never empty. Sending /
 * dispatch is out of scope for this milestone -- these are static
 * demonstration numbers, not live metrics.
 */
async function seedDemoData(
  organizationId: number,
  dbClient: DbClient = db,
): Promise<void> {
  const [waba] = await dbClient
    .insert(wabasTable)
    .values({
      organizationId,
      externalId: `waba_sample_${Math.random().toString(36).slice(2, 8)}`,
      displayName: "Sample WhatsApp Business Account",
    })
    .returning();

  const [phoneA] = await dbClient
    .insert(phoneNumbersTable)
    .values([
      {
        organizationId,
        wabaId: waba.id,
        phone: "+1 555-0114",
        displayName: "Sales Line (Sample)",
        provider: "Cloud API",
        quality: "High",
        status: "Connected",
        tpsLimit: 80,
        isSample: true,
      },
      {
        organizationId,
        wabaId: waba.id,
        phone: "+1 555-0128",
        displayName: "Support Line (Sample)",
        provider: "Cloud API",
        quality: "Medium",
        status: "Connected",
        tpsLimit: 40,
        isSample: true,
      },
    ])
    .returning();

  await dbClient.insert(contactsTable).values([
    {
      organizationId,
      name: "Ava Thompson (Sample)",
      phone: "+1 555-0101",
      email: "ava.sample@example.com",
      tags: ["VIP", "Sample"],
      status: "Active",
      source: "Sample Data",
      isSample: true,
    },
    {
      organizationId,
      name: "Marcus Lee (Sample)",
      phone: "+1 555-0142",
      email: "marcus.sample@example.com",
      tags: ["Newsletter", "Sample"],
      status: "Active",
      source: "Sample Data",
      isSample: true,
    },
    {
      organizationId,
      name: "Priya Natarajan (Sample)",
      phone: "+1 555-0157",
      email: null,
      tags: ["Sample"],
      status: "Inactive",
      source: "Sample Data",
      isSample: true,
    },
  ]);

  const [templateA] = await dbClient
    .insert(templatesTable)
    .values([
      {
        organizationId,
        name: "Welcome Message (Sample)",
        category: "Marketing",
        language: "en_US",
        status: "Approved",
        body: "Hi {{1}}, welcome to Wabista! We're glad to have you.",
        isSample: true,
      },
      {
        organizationId,
        name: "Order Update (Sample)",
        category: "Utility",
        language: "en_US",
        status: "Approved",
        body: "Hi {{1}}, your order #{{2}} has shipped.",
        isSample: true,
      },
    ])
    .returning();

  const [campaign] = await dbClient
    .insert(campaignsTable)
    .values({
      organizationId,
      name: "Welcome Series (Sample)",
      status: "Running",
      audienceSize: 120,
      sent: 96,
      delivered: 90,
      read: 61,
      failed: 4,
      scheduleLabel: "Ongoing",
      isSample: true,
    })
    .returning();

  await dbClient.insert(campaignRoutesTable).values({
    organizationId,
    campaignId: campaign.id,
    phoneNumberId: phoneA.id,
    templateId: templateA.id,
    priority: "High",
    configuredTps: 60,
    currentTps: 42,
    queueDepth: 18,
    status: "Active",
    isSample: true,
  });
}

/**
 * Accepts every Pending invitation addressed to this user's email (matched
 * case-insensitively -- Clerk preserves user-typed casing on sign-up, so an
 * exact-string match would intermittently miss a real match) by creating the
 * corresponding organization membership and marking the invitation
 * Accepted. Returns the resulting memberships, newest-invitation-last so the
 * earliest invite naturally becomes the default active org. Returns an
 * empty array if there were no pending invitations for this email.
 */
export async function acceptPendingInvitations(
  user: User,
  dbClient: DbClient = db,
): Promise<{ organizationId: number; role: OrganizationRole }[]> {
  const pending = await dbClient
    .select()
    .from(organizationInvitationsTable)
    .where(
      and(
        eq(sql`lower(${organizationInvitationsTable.email})`, user.email.trim().toLowerCase()),
        eq(organizationInvitationsTable.status, "Pending"),
      ),
    )
    .orderBy(organizationInvitationsTable.id);

  const memberships: { organizationId: number; role: OrganizationRole }[] = [];
  for (const invitation of pending) {
    const [membership] = await dbClient
      .insert(organizationMembersTable)
      .values({
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
      })
      .returning();
    await dbClient
      .update(organizationInvitationsTable)
      .set({ status: "Accepted", acceptedByUserId: user.id, acceptedAt: new Date() })
      .where(eq(organizationInvitationsTable.id, invitation.id));
    memberships.push({ organizationId: membership.organizationId, role: membership.role as OrganizationRole });
  }
  return memberships;
}

/**
 * Creates a personal organization (tenant) for a brand-new user, with an
 * Owner membership, and seeds it with demo data. Runs once, on a user's
 * first-ever login (see attachOrgContext).
 */
export async function provisionPersonalOrganization(
  user: User,
  dbClient: DbClient = db,
): Promise<{ organizationId: number; membershipId: number }> {
  const displayName = user.name || user.email.split("@")[0] || "My";
  const [org] = await dbClient
    .insert(organizationsTable)
    .values({
      name: `${displayName}'s Workspace`,
      slug: slugify(displayName),
    })
    .returning();

  const [membership] = await dbClient
    .insert(organizationMembersTable)
    .values({ organizationId: org.id, userId: user.id, role: "owner" })
    .returning();

  await seedDemoData(org.id, dbClient);

  return { organizationId: org.id, membershipId: membership.id };
}
