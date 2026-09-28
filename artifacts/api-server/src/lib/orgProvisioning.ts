import { and, eq, sql } from "drizzle-orm";
import {
  db,
  organizationInvitationsTable,
  organizationMembersTable,
  organizationsTable,
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
 * Creates a personal organization (tenant) for a brand-new user with an
 * Owner membership. Runs once, on a user's first-ever login (see
 * attachOrgContext). The workspace is created genuinely empty: no sample
 * numbers, contacts, templates, campaigns or routes are seeded, so Home and
 * every list reflect only what the user actually connects or creates.
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

  return { organizationId: org.id, membershipId: membership.id };
}
