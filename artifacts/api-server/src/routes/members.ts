import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  organizationInvitationsTable,
  organizationMembersTable,
  usersTable,
  type OrganizationRole,
} from "@workspace/db";
import {
  InviteMemberBody,
  ListMembersResponse,
  RemoveMemberParams,
  UpdateMemberRoleBody,
  UpdateMemberRoleParams,
  UpdateMemberRoleResponse,
  InviteMemberResponse,
} from "@workspace/api-zod";
import {
  attachOrgContext,
  requireAuth,
  requireRole,
} from "../middlewares/auth";

const router: IRouter = Router();

function serializeMember(
  row: {
    id: number;
    userId: number;
    name: string;
    email: string;
    role: string;
    createdAt: Date;
  },
  currentUserId: number,
) {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role as OrganizationRole,
    isSelf: row.userId === currentUserId,
    createdAt: row.createdAt,
  };
}

router.get(
  "/members",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const rows = await db
      .select({
        id: organizationMembersTable.id,
        userId: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: organizationMembersTable.role,
        createdAt: organizationMembersTable.createdAt,
      })
      .from(organizationMembersTable)
      .innerJoin(usersTable, eq(organizationMembersTable.userId, usersTable.id))
      .where(eq(organizationMembersTable.organizationId, req.organizationId!))
      .orderBy(organizationMembersTable.id);

    res.json(
      ListMembersResponse.parse(
        rows.map((r) => serializeMember(r, req.authUser!.id)),
      ),
    );
  },
);

router.post(
  "/members",
  requireAuth,
  attachOrgContext,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const body = InviteMemberBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    if (body.data.role === "owner" && req.role !== "owner") {
      res
        .status(403)
        .json({ error: "Only an Owner can grant the Owner role" });
      return;
    }

    const normalizedEmail = body.data.email.trim().toLowerCase();
    const [targetUser] = await db
      .select()
      .from(usersTable)
      .where(eq(sql`lower(${usersTable.email})`, normalizedEmail));

    // No account with that email yet: create (or refresh) a pending
    // invitation instead of failing. It is accepted automatically the
    // first time this email signs up (see attachOrgContext).
    if (!targetUser) {
      const [existingPending] = await db
        .select()
        .from(organizationInvitationsTable)
        .where(
          and(
            eq(organizationInvitationsTable.organizationId, req.organizationId!),
            eq(organizationInvitationsTable.email, normalizedEmail),
            eq(organizationInvitationsTable.status, "Pending"),
          ),
        );

      // A revoked-then-re-invited row also gets a fresh token, so a
      // previously shared/leaked link from a revoked invite stops working.
      const [invitation] = existingPending
        ? await db
            .update(organizationInvitationsTable)
            .set({
              role: body.data.role ?? "agent",
              invitedByUserId: req.authUser!.id,
              token: randomUUID(),
            })
            .where(eq(organizationInvitationsTable.id, existingPending.id))
            .returning()
        : await db
            .insert(organizationInvitationsTable)
            .values({
              organizationId: req.organizationId!,
              email: normalizedEmail,
              role: body.data.role ?? "agent",
              invitedByUserId: req.authUser!.id,
              token: randomUUID(),
            })
            .returning();

      res.status(201).json(
        InviteMemberResponse.parse({
          invitation: {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role as OrganizationRole,
            status: invitation.status as "Pending" | "Accepted" | "Revoked",
            invitedByName: req.authUser!.name,
            createdAt: invitation.createdAt,
            token: invitation.token,
          },
        }),
      );
      return;
    }

    const [existingMembership] = await db
      .select()
      .from(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.organizationId, req.organizationId!),
          eq(organizationMembersTable.userId, targetUser.id),
        ),
      );

    if (existingMembership) {
      res
        .status(409)
        .json({ error: "This user is already a member of the organization" });
      return;
    }

    const [membership] = await db
      .insert(organizationMembersTable)
      .values({
        organizationId: req.organizationId!,
        userId: targetUser.id,
        role: body.data.role ?? "agent",
      })
      .returning();

    res.status(201).json(
      InviteMemberResponse.parse({
        member: serializeMember(
          {
            id: membership.id,
            userId: targetUser.id,
            name: targetUser.name,
            email: targetUser.email,
            role: membership.role,
            createdAt: membership.createdAt,
          },
          req.authUser!.id,
        ),
      }),
    );
  },
);

router.patch(
  "/members/:memberId",
  requireAuth,
  attachOrgContext,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const params = UpdateMemberRoleParams.safeParse(req.params);
    const body = UpdateMemberRoleBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res
        .status(400)
        .json({ error: params.error?.message ?? body.error?.message });
      return;
    }

    const [target] = await db
      .select()
      .from(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.id, params.data.memberId),
          eq(organizationMembersTable.organizationId, req.organizationId!),
        ),
      );

    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    // Only an Owner may change an Owner's role or promote someone to Owner.
    if (
      (target.role === "owner" || body.data.role === "owner") &&
      req.role !== "owner"
    ) {
      res
        .status(403)
        .json({ error: "Only an Owner can change Owner-level roles" });
      return;
    }

    if (target.role === "owner" && body.data.role !== "owner") {
      const owners = await db
        .select()
        .from(organizationMembersTable)
        .where(
          and(
            eq(organizationMembersTable.organizationId, req.organizationId!),
            eq(organizationMembersTable.role, "owner"),
          ),
        );
      if (owners.length <= 1) {
        res
          .status(409)
          .json({ error: "An organization must keep at least one Owner" });
        return;
      }
    }

    // Re-assert the org predicate directly on the write (not just the
    // earlier read) so this mutation can never affect another tenant's row
    // even if a future refactor changes how `target` is resolved.
    const [updated] = await db
      .update(organizationMembersTable)
      .set({ role: body.data.role })
      .where(
        and(
          eq(organizationMembersTable.id, target.id),
          eq(organizationMembersTable.organizationId, req.organizationId!),
        ),
      )
      .returning();

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, updated.userId));

    res.json(
      UpdateMemberRoleResponse.parse(
        serializeMember(
          {
            id: updated.id,
            userId: user.id,
            name: user.name,
            email: user.email,
            role: updated.role,
            createdAt: updated.createdAt,
          },
          req.authUser!.id,
        ),
      ),
    );
  },
);

router.delete(
  "/members/:memberId",
  requireAuth,
  attachOrgContext,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const params = RemoveMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [target] = await db
      .select()
      .from(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.id, params.data.memberId),
          eq(organizationMembersTable.organizationId, req.organizationId!),
        ),
      );

    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    if (target.userId === req.authUser!.id) {
      res
        .status(409)
        .json({ error: "You cannot remove yourself from the organization" });
      return;
    }

    // Only an Owner may remove another Owner (mirrors the role-update route).
    if (target.role === "owner" && req.role !== "owner") {
      res
        .status(403)
        .json({ error: "Only an Owner can remove an Owner" });
      return;
    }

    if (target.role === "owner") {
      const owners = await db
        .select()
        .from(organizationMembersTable)
        .where(
          and(
            eq(organizationMembersTable.organizationId, req.organizationId!),
            eq(organizationMembersTable.role, "owner"),
          ),
        );
      if (owners.length <= 1) {
        res
          .status(409)
          .json({ error: "An organization must keep at least one Owner" });
        return;
      }
    }

    // Re-assert the org predicate directly on the write (see the matching
    // comment in the role-update route above).
    await db
      .delete(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.id, target.id),
          eq(organizationMembersTable.organizationId, req.organizationId!),
        ),
      );

    res.status(204).send();
  },
);

export default router;
