import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationMembersTable,
  organizationsTable,
  type OrganizationRole,
} from "@workspace/db";
import {
  ActivateOrganizationParams,
  ActivateOrganizationResponse,
  ListOrganizationsResponse,
  UpdateOrganizationBody,
  UpdateOrganizationParams,
  UpdateOrganizationResponse,
} from "@workspace/api-zod";
import {
  ACTIVE_ORG_COOKIE,
  attachOrgContext,
  requireAuth,
  requireRole,
} from "../middlewares/auth";

const router: IRouter = Router();

async function listMembershipsFor(userId: number, activeOrgId: number) {
  const rows = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      role: organizationMembersTable.role,
      createdAt: organizationsTable.createdAt,
      updatedAt: organizationsTable.updatedAt,
    })
    .from(organizationMembersTable)
    .innerJoin(
      organizationsTable,
      eq(organizationMembersTable.organizationId, organizationsTable.id),
    )
    .where(eq(organizationMembersTable.userId, userId))
    .orderBy(organizationMembersTable.id);

  return rows.map((row) => ({
    ...row,
    role: row.role as OrganizationRole,
    isActive: row.id === activeOrgId,
  }));
}

router.get(
  "/organizations",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const orgs = await listMembershipsFor(
      req.authUser!.id,
      req.organizationId!,
    );
    res.json(ListOrganizationsResponse.parse(orgs));
  },
);

router.post(
  "/organizations/:organizationId/activate",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const params = ActivateOrganizationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [membership] = await db
      .select()
      .from(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.organizationId, params.data.organizationId),
          eq(organizationMembersTable.userId, req.authUser!.id),
        ),
      );

    if (!membership) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    res.cookie(ACTIVE_ORG_COOKIE, String(params.data.organizationId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 365,
      path: "/",
    });

    const orgs = await listMembershipsFor(
      req.authUser!.id,
      params.data.organizationId,
    );
    res.json(ActivateOrganizationResponse.parse(orgs));
  },
);

router.patch(
  "/organizations/:organizationId",
  requireAuth,
  attachOrgContext,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const params = UpdateOrganizationParams.safeParse(req.params);
    const body = UpdateOrganizationBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res
        .status(400)
        .json({ error: params.error?.message ?? body.error?.message });
      return;
    }

    if (params.data.organizationId !== req.organizationId) {
      res.status(403).json({ error: "Cannot modify a different organization" });
      return;
    }

    const [updated] = await db
      .update(organizationsTable)
      .set({ name: body.data.name })
      .where(eq(organizationsTable.id, params.data.organizationId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    res.json(
      UpdateOrganizationResponse.parse({
        ...updated,
        role: req.role,
        isActive: true,
      }),
    );
  },
);

export default router;
