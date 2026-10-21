import type { NextFunction, Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  organizationMembersTable,
  usersTable,
  type OrganizationRole,
  type User,
} from "@workspace/db";
import { authUserLinksTable } from "@workspace/db/auth";
import { acceptPendingInvitations, provisionPersonalOrganization } from "../lib/orgProvisioning";

export const ACTIVE_ORG_COOKIE = "wabista_active_org_id";

const ROLE_RANK: Record<OrganizationRole, number> = {
  owner: 4,
  admin: 3,
  manager: 2,
  agent: 1,
};

/** The signed-in Better Auth user, as resolved by middlewares/session.ts. */
export type AuthSessionUser = { id: string; email: string; name: string; emailVerified: boolean };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set for every /api request by resolveAuthSession: null when signed out. */
      authSession?: { user: AuthSessionUser; session: { id: string; expiresAt: Date } } | null;
      authUser?: {
        id: number;
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

/**
 * The local user (integer id used by every membership, role and authorship column) for a Better Auth user,
 * created on first use and linked through auth_user_links. Race-safe without extra locks: concurrent first
 * requests insert the same placeholder `clerk_id` (`better-auth:<id>`, unique), so one insert wins and the
 * others re-read it. A legacy row with the same email is never linked (email ownership is not verified).
 */
export async function getOrCreateLocalUser(authUser: AuthSessionUser): Promise<User> {
  const [linked] = await db
    .select({ user: usersTable })
    .from(authUserLinksTable)
    .innerJoin(usersTable, eq(usersTable.id, authUserLinksTable.userId))
    .where(eq(authUserLinksTable.authUserId, authUser.id));
  if (linked) return linked.user;

  const placeholder = `better-auth:${authUser.id}`;
  const email = authUser.email.trim().toLowerCase();
  const name = authUser.name.trim() || email.split("@")[0] || "New User";
  return db.transaction(async (tx) => {
    await tx.insert(usersTable).values({ clerkId: placeholder, email, name }).onConflictDoNothing({ target: usersTable.clerkId });
    const [user] = await tx.select().from(usersTable).where(eq(usersTable.clerkId, placeholder));
    if (!user) throw new Error("Failed to provision the local user");
    await tx.insert(authUserLinksTable).values({ authUserId: authUser.id, userId: user.id }).onConflictDoNothing();
    return user;
  });
}

/**
 * Requires a signed-in Better Auth session (resolved by middlewares/session.ts). Rejects with 401 otherwise.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.authSession) {
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
  const authUser = req.authSession?.user;
  if (!authUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = await getOrCreateLocalUser(authUser);

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
        // organizations by email before ever creating an account. Accepting
        // by email alone is only safe when the account's email ownership is
        // verified (Better Auth email/password does not verify it, so this
        // never runs today); otherwise the invitee joins with the invite
        // link (POST /invitations/accept, token + matching email).
        const accepted = authUser.emailVerified ? await acceptPendingInvitations(user, tx) : [];
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
