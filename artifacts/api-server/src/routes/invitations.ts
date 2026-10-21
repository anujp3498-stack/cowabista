import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationInvitationsTable,
  usersTable,
  type OrganizationRole,
} from "@workspace/db";
import {
  AcceptInvitationBody,
  AcceptInvitationResponse,
  ListInvitationsResponse,
  RevokeInvitationParams,
  GetInvitationPreviewParams,
  GetInvitationPreviewResponse,
} from "@workspace/api-zod";
import { organizationsTable } from "@workspace/db";
import { ACTIVE_ORG_COOKIE, attachOrgContext, getOrCreateLocalUser, requireAuth, requireRole } from "../middlewares/auth";
import { acceptInvitationByToken, InvitationAcceptError } from "../lib/orgProvisioning";

const router: IRouter = Router();

router.get(
  "/invitations",
  requireAuth,
  attachOrgContext,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const rows = await db
      .select({
        id: organizationInvitationsTable.id,
        email: organizationInvitationsTable.email,
        role: organizationInvitationsTable.role,
        status: organizationInvitationsTable.status,
        invitedByName: usersTable.name,
        createdAt: organizationInvitationsTable.createdAt,
        token: organizationInvitationsTable.token,
      })
      .from(organizationInvitationsTable)
      .leftJoin(usersTable, eq(usersTable.id, organizationInvitationsTable.invitedByUserId))
      .where(
        and(
          eq(organizationInvitationsTable.organizationId, req.organizationId!),
          eq(organizationInvitationsTable.status, "Pending"),
        ),
      )
      .orderBy(organizationInvitationsTable.id);

    res.json(
      ListInvitationsResponse.parse(
        rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role as OrganizationRole,
          status: r.status as "Pending" | "Accepted" | "Revoked",
          invitedByName: r.invitedByName,
          createdAt: r.createdAt,
          token: r.token,
        })),
      ),
    );
  },
);

// Public (no auth) lookup so a shareable invite link can show "you're
// invited to join <org> as <role>" before the visitor has signed in. It
// never grants membership itself -- acceptance is POST /invitations/accept
// below, signed in with the invited address.
router.get(
  "/invite-info/:token",
  async (req, res): Promise<void> => {
    const params = GetInvitationPreviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [row] = await db
      .select({
        email: organizationInvitationsTable.email,
        role: organizationInvitationsTable.role,
        status: organizationInvitationsTable.status,
        organizationName: organizationsTable.name,
      })
      .from(organizationInvitationsTable)
      .innerJoin(
        organizationsTable,
        eq(organizationsTable.id, organizationInvitationsTable.organizationId),
      )
      .where(eq(organizationInvitationsTable.token, params.data.token));

    if (!row) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    res.json(
      GetInvitationPreviewResponse.parse({
        organizationName: row.organizationName,
        role: row.role as OrganizationRole,
        email: row.email,
        status: row.status as "Pending" | "Accepted" | "Revoked",
      }),
    );
  },
);

// Token-bound acceptance (D1). Deliberately without attachOrgContext: a
// brand-new invitee's first API call must not provision a personal workspace
// before joining. The token travels in the body, never the URL (which the
// request log records).
router.post(
  "/invitations/accept",
  requireAuth,
  async (req, res): Promise<void> => {
    const body = AcceptInvitationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "An invitation token is required" });
      return;
    }
    const authUser = req.authSession!.user;
    try {
      const user = await getOrCreateLocalUser(authUser);
      const accepted = await acceptInvitationByToken(user, authUser.email, body.data.token);
      res.cookie(ACTIVE_ORG_COOKIE, String(accepted.organizationId), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24 * 365,
        path: "/",
      });
      res.json(AcceptInvitationResponse.parse(accepted));
    } catch (error) {
      if (error instanceof InvitationAcceptError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  },
);

router.delete(
  "/invitations/:invitationId",
  requireAuth,
  attachOrgContext,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const params = RevokeInvitationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [target] = await db
      .select()
      .from(organizationInvitationsTable)
      .where(
        and(
          eq(organizationInvitationsTable.id, params.data.invitationId),
          eq(organizationInvitationsTable.organizationId, req.organizationId!),
        ),
      );

    if (!target || target.status !== "Pending") {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    // Only an Owner may revoke an invitation that would grant Owner --
    // mirrors the equivalent rank rule on member role updates/removal.
    if (target.role === "owner" && req.role !== "owner") {
      res.status(403).json({ error: "Only an Owner can revoke an Owner invitation" });
      return;
    }

    // Re-assert the org predicate directly on the write, not just the
    // earlier read, so this can never affect another tenant's invitation.
    await db
      .update(organizationInvitationsTable)
      .set({ status: "Revoked" })
      .where(
        and(
          eq(organizationInvitationsTable.id, target.id),
          eq(organizationInvitationsTable.organizationId, req.organizationId!),
        ),
      );

    res.status(204).send();
  },
);

export default router;
