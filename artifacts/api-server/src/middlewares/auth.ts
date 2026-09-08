import type { NextFunction, Request, Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  organizationMembersTable,
  usersTable,
  type OrganizationRole,
  type User,
} from "@workspace/db";
import { acceptPendingInvitations, provisionPersonalOrganization } from "../lib/orgProvisioning";

export const ACTIVE_ORG_COOKIE = "wabista_active_org_id";

const ROLE_RANK: Record<OrganizationRole, number> = {
  owner: 4,
  admin: 3,
  manager: 2,
  agent: 1,
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: {
        id: number;
        clerkId: string;
        email: string;
        name: string;
        isPlatformAdmin: boolean;
        createdAt: Date;
      };
      organizationId?: number;
      role?: OrganizationRole;
    }
  }
}

async function getOrCreateLocalUser(clerkId: string): Promise<User> {
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));
  if (existing) return existing;

  const clerkUser = await clerkClient.users.getUser(clerkId);
  const primaryEmail = clerkUser.emailAddresses.find(
    (e) => e.id === clerkUser.primaryEmailAddressId,
  );
  const email =
    primaryEmail?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    `${clerkId}@unknown.local`;
  const name =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
    email.split("@")[0] ||
    "New User";

  // Insert can race with another concurrent request for the same brand-new
  // user; fall back to reading the row created by the other request.
  try {
    const [created] = await db
      .insert(usersTable)
      .values({ clerkId, email, name })
      .returning();
    return created;
  } catch {
    const [raced] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkId, clerkId));
    if (raced) return raced;
    throw new Error(`Failed to provision local user for ${clerkId}`);
  }
}

/**
 * Requires a valid Clerk session. Rejects with 401 otherwise.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * Must run after requireAuth. JIT-provisions the local user record and, on
 * first login, a personal organization with an Owner membership (seeded
 * with demo data). Resolves the request's active organization from the
 * `wabista_active_org_id` cookie, falling back to the user's earliest
 * (personal) organization.
 */
export async function attachOrgContext(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const clerkId = auth?.userId;
  if (!clerkId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = await getOrCreateLocalUser(clerkId);

    let memberships = await db
      .select({
        organizationId: organizationMembersTable.organizationId,
        role: organizationMembersTable.role,
      })
      .from(organizationMembersTable)
      .where(eq(organizationMembersTable.userId, user.id))
      .orderBy(organizationMembersTable.id);

    if (memberships.length === 0) {
      // A brand-new user's very first requests (e.g. the dashboard's
      // initial batch of API calls) can arrive concurrently. Without
      // serializing, two requests could each observe zero memberships and
      // independently provision two separate personal organizations. A
      // per-user Postgres advisory lock (held for the transaction) plus a
      // re-check inside it ensures only one request ever provisions.
      memberships = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${user.id})`);
        const existing = await tx
          .select({
            organizationId: organizationMembersTable.organizationId,
            role: organizationMembersTable.role,
          })
          .from(organizationMembersTable)
          .where(eq(organizationMembersTable.userId, user.id))
          .orderBy(organizationMembersTable.id);
        if (existing.length > 0) return existing;

        // A brand-new signup may have been invited to one or more
        // organizations by email before ever creating an account. Accept
        // those invitations instead of provisioning a fresh personal
        // workspace, so the person lands directly on their team(s).
        const accepted = await acceptPendingInvitations(user, tx);
        if (accepted.length > 0) return accepted;

        const created = await provisionPersonalOrganization(user, tx);
        return [
          { organizationId: created.organizationId, role: "owner" as const },
        ];
      });
    }

    const cookieOrgId = Number(req.cookies?.[ACTIVE_ORG_COOKIE]);
    const active =
      (Number.isFinite(cookieOrgId) &&
        memberships.find((m) => m.organizationId === cookieOrgId)) ||
      memberships[0];

    req.authUser = {
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
      createdAt: user.createdAt,
    };
    req.organizationId = active.organizationId;
    req.role = active.role as OrganizationRole;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Must run after attachOrgContext. Rejects with 403 when the caller's role
 * in the active organization is below `minRole` in the owner > admin >
 * manager > agent hierarchy.
 */
export function requireRole(minRole: OrganizationRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.role || ROLE_RANK[req.role] < ROLE_RANK[minRole]) {
      res
        .status(403)
        .json({ error: "You do not have permission to perform this action" });
      return;
    }
    next();
  };
}

/**
 * Must run after attachOrgContext on routes that carry an organizationId path
 * parameter. Prevents a caller from addressing another tenant by changing the
 * URL while retaining their own active organization context.
 */
export function requireActiveOrganization(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const organizationId = Number(req.params.organizationId);
  if (
    !Number.isInteger(organizationId) ||
    organizationId <= 0 ||
    organizationId !== req.organizationId
  ) {
    res.status(403).json({ error: "Organization access denied" });
    return;
  }
  next();
}
