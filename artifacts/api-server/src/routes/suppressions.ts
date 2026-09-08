import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db, suppressionsTable } from "@workspace/db";
import {
  CreateSuppressionBody,
  CreateSuppressionResponse,
  DeleteSuppressionParams,
  ListSuppressionsQueryParams,
  ListSuppressionsResponse,
} from "@workspace/api-zod";
import { attachOrgContext, requireAuth, requireRole } from "../middlewares/auth";
import { normalizePhone } from "../services/contact-processing";

const router: IRouter = Router();

/**
 * Do-not-contact list management. Entries here are also written to
 * automatically -- by CSV import (suppression check) and by inbound STOP
 * replies (see services/whatsapp-webhook.ts) -- this route only covers the
 * manual view/add/remove staff need on top of that.
 */

router.get("/suppressions", requireAuth, attachOrgContext, async (req, res): Promise<void> => {
  const query = ListSuppressionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const limit = Math.min(Math.max(query.data.limit ?? 25, 1), 100);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const conditions = [eq(suppressionsTable.organizationId, req.organizationId!)];
  if (query.data.search) conditions.push(ilike(suppressionsTable.normalizedPhone, `%${query.data.search}%`));

  const [{ count } = { count: 0 }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(suppressionsTable).where(and(...conditions));
  const rows = await db.select().from(suppressionsTable).where(and(...conditions))
    .orderBy(desc(suppressionsTable.createdAt)).limit(limit).offset(offset);

  res.json(ListSuppressionsResponse.parse({ total: count, limit, offset, suppressions: rows }));
});

router.post(
  "/suppressions",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const body = CreateSuppressionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const normalized = normalizePhone(body.data.phone);
    if (!normalized.value) {
      res.status(400).json({ error: normalized.error ?? "Invalid phone number" });
      return;
    }
    const reason = body.data.reason?.trim() || "Manually suppressed";
    const [row] = await db.insert(suppressionsTable).values({
      organizationId: req.organizationId!,
      normalizedPhone: normalized.value,
      reason,
    }).onConflictDoUpdate({
      target: [suppressionsTable.organizationId, suppressionsTable.normalizedPhone],
      set: { reason, updatedAt: new Date() },
    }).returning();
    res.status(201).json(CreateSuppressionResponse.parse(row));
  },
);

router.delete(
  "/suppressions/:suppressionId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = DeleteSuppressionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [deleted] = await db.delete(suppressionsTable).where(and(
      eq(suppressionsTable.id, params.data.suppressionId),
      eq(suppressionsTable.organizationId, req.organizationId!),
    )).returning();
    if (!deleted) {
      res.status(404).json({ error: "Suppression not found" });
      return;
    }
    res.status(204).send();
  },
);

export default router;
