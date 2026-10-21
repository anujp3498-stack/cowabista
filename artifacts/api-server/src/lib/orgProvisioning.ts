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
 * case-insensitively; invitation rows written before the Better Auth move may
 * carry user-typed casing) by creating the corresponding organization
 * membership and marking the invitation Accepted. Email alone proves nothing
 * unless the account's email is verified, so attachOrgContext calls this only
 * for verified accounts; everyone else accepts with the token
 * (acceptInvitationByToken). Returns the resulting memberships, newest-invitation-last so the
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

export class InvitationAcceptError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: "invitation_email_mismatch" | "invitation_not_found" | "invitation_not_pending",
    message: string,
  ) {
    super(message);
    this.name = "InvitationAcceptError";
  }
}

/**
 * Token-bound acceptance: the signed-in user holding a Pending invitation's token joins with the invited role,
 * but only when their account email equals the invitation's email (decision D1; email ownership is not
 * verified, so neither the token nor the email alone is enough). Serialised with first-login provisioning by
 * the same per-user advisory lock as attachOrgContext, and the invitation row is locked, so concurrent accepts
 * create one membership. An existing member keeps their current role.
 */
export async function acceptInvitationByToken(
  user: User,
  authEmail: string,
  token: string,
): Promise<{ organizationId: number; role: OrganizationRole }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${user.id})`);
    const [invitation] = await tx
      .select()
      .from(organizationInvitationsTable)
      .where(eq(organizationInvitationsTable.token, token))
      .for("update");
    if (!invitation) throw new InvitationAcceptError(404, "invitation_not_found", "Invitation not found");
    if (invitation.status !== "Pending") {
      throw new InvitationAcceptError(409, "invitation_not_pending", "This invitation is no longer pending");
    }
    if (invitation.email.trim().toLowerCase() !== authEmail.trim().toLowerCase()) {
      throw new InvitationAcceptError(403, "invitation_email_mismatch", "This invitation was sent to a different email address. Sign in with that address to accept it.");
    }
    await tx
      .insert(organizationMembersTable)
      .values({ organizationId: invitation.organizationId, userId: user.id, role: invitation.role })
      .onConflictDoNothing({ target: [organizationMembersTable.organizationId, organizationMembersTable.userId] });
    const [membership] = await tx
      .select({ role: organizationMembersTable.role })
      .from(organizationMembersTable)
      .where(and(eq(organizationMembersTable.organizationId, invitation.organizationId), eq(organizationMembersTable.userId, user.id)));
    await tx
      .update(organizationInvitationsTable)
      .set({ status: "Accepted", acceptedByUserId: user.id, acceptedAt: new Date() })
      .where(eq(organizationInvitationsTable.id, invitation.id));
    return { organizationId: invitation.organizationId, role: membership!.role as OrganizationRole };
  });
}
