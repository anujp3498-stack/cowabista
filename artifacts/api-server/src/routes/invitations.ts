import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationInvitationsTable,
  usersTable,
  type OrganizationRole,
} from "@workspace/db";
import {
  ListInvitationsResponse,
  RevokeInvitationParams,
  GetInvitationPreviewParams,
  GetInvitationPreviewResponse,
} from "@workspace/api-zod";
import { organizationsTable } from "@workspace/db";
import { attachOrgContext, requireAuth, requireRole } from "../middlewares/auth";

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
// never grants membership itself -- acceptance still happens through the
// existing email-match logic in attachOrgContext once the invitee signs in
// or signs up with the invited address.
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
