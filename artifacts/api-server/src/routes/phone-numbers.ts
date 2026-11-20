import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { campaignRoutesTable, campaignsTable, db, phoneNumbersTable, wabasTable } from "@workspace/db";
import {
  CreatePhoneNumberBody,
  CreatePhoneNumberResponse,
  DeletePhoneNumberParams,
  ListPhoneNumbersResponse,
  UpdatePhoneNumberBody,
  UpdatePhoneNumberParams,
  UpdatePhoneNumberResponse,
} from "@workspace/api-zod";
import {
  attachOrgContext,
  requireAuth,
  requireRole,
} from "../middlewares/auth";

const router: IRouter = Router();
const DEFAULT_UNVERIFIED_TPS_LIMIT = 50;

async function serializePhoneNumber(row: typeof phoneNumbersTable.$inferSelect) {
  let wabaExternalId: string | null = null;
  let wabaDisplayName: string | null = null;
  if (row.wabaId) {
    const [waba] = await db
      .select()
      .from(wabasTable)
      .where(eq(wabasTable.id, row.wabaId));
    wabaExternalId = waba?.externalId ?? null;
    wabaDisplayName = waba?.displayName ?? null;
  }
  return { ...row, wabaExternalId, wabaDisplayName };
}

/** Get-or-create the WABA row for a given external id, scoped to the org. */
async function resolveWabaId(
  organizationId: number,
  externalId: string | null | undefined,
): Promise<number | null> {
  const trimmed = externalId?.trim();
  if (!trimmed) return null;

  const [existing] = await db
    .select()
    .from(wabasTable)
    .where(
      and(
        eq(wabasTable.organizationId, organizationId),
        eq(wabasTable.externalId, trimmed),
      ),
    );
  if (existing) return existing.id;

  const [created] = await db
    .insert(wabasTable)
    .values({
      organizationId,
      externalId: trimmed,
      displayName: trimmed,
    })
    .returning();
  return created.id;
}

router.get(
  "/phone-numbers",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(phoneNumbersTable)
      .where(and(
        eq(phoneNumbersTable.organizationId, req.organizationId!),
        isNull(phoneNumbersTable.archivedAt),
      ))
      .orderBy(desc(phoneNumbersTable.createdAt));

    const serialized = await Promise.all(rows.map(serializePhoneNumber));
    res.json(ListPhoneNumbersResponse.parse(serialized));
  },
);

router.post(
  "/phone-numbers",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const body = CreatePhoneNumberBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if ((body.data.tpsLimit ?? DEFAULT_UNVERIFIED_TPS_LIMIT) > DEFAULT_UNVERIFIED_TPS_LIMIT) {
      res.status(409).json({
        error: "TPS above the conservative default requires a synchronized provider-approved cap",
      });
      return;
    }

    const { wabaExternalId, ...rest } = body.data;
    const wabaId = await resolveWabaId(req.organizationId!, wabaExternalId);

    const [phoneNumber] = await db
      .insert(phoneNumbersTable)
      .values({ ...rest, wabaId, organizationId: req.organizationId! })
      .returning();

    res
      .status(201)
      .json(CreatePhoneNumberResponse.parse(await serializePhoneNumber(phoneNumber)));
  },
);

router.patch(
  "/phone-numbers/:phoneNumberId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = UpdatePhoneNumberParams.safeParse(req.params);
    const body = UpdatePhoneNumberBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res
        .status(400)
        .json({ error: params.error?.message ?? body.error?.message });
      return;
    }

    const [existing] = await db.select().from(phoneNumbersTable).where(and(
      eq(phoneNumbersTable.id, params.data.phoneNumberId),
      eq(phoneNumbersTable.organizationId, req.organizationId!),
    ));
    if (!existing) {
      res.status(404).json({ error: "Phone number not found" });
      return;
    }
    if (existing.archivedAt) {
      res.status(409).json({ code: "phone_archived", error: "This number is archived. Restore it explicitly before editing." });
      return;
    }
    if (body.data.tpsLimit !== undefined && body.data.tpsLimit > existing.tpsLimit) {
      const approved = existing.providerMetadata.approvedTpsLimit;
      if (
        typeof approved !== "number" ||
        !Number.isInteger(approved) ||
        body.data.tpsLimit > approved
      ) {
        res.status(409).json({
          error: "TPS increases require a synchronized provider-approved cap",
        });
        return;
      }
    }

    const { wabaExternalId, ...rest } = body.data;
    const values: Partial<typeof phoneNumbersTable.$inferInsert> = { ...rest };
    if (wabaExternalId !== undefined) {
      values.wabaId = await resolveWabaId(req.organizationId!, wabaExternalId);
    }

    const [updated] = await db
      .update(phoneNumbersTable)
      .set(values)
      .where(
        and(
          eq(phoneNumbersTable.id, params.data.phoneNumberId),
          eq(phoneNumbersTable.organizationId, req.organizationId!),
          isNull(phoneNumbersTable.archivedAt),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Phone number not found" });
      return;
    }

    res.json(UpdatePhoneNumberResponse.parse(await serializePhoneNumber(updated)));
  },
);

router.delete(
  "/phone-numbers/:phoneNumberId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = DeletePhoneNumberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    // V2-375A1: archive, never hard-delete. The existing provider phone ID
    // remains reserved for historical routes, allocations, jobs and receipts.
    // Share the setup advisory key so an in-flight activation cannot commit
    // after archival. The row lock serializes concurrent sync/upsert writes.
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whatsapp-phone-setup:${req.organizationId!}:${params.data.phoneNumberId}`}))`);
      const [existing] = await tx.select().from(phoneNumbersTable).where(and(
        eq(phoneNumbersTable.id, params.data.phoneNumberId),
        eq(phoneNumbersTable.organizationId, req.organizationId!),
      )).for("update");
      if (!existing) return "missing" as const;
      if (existing.archivedAt) return "already_archived" as const;

      // Fail closed if a route might still be launched, resumed or executed.
      // Terminal campaigns keep their historic routes and message records.
      const [inUse] = await tx.select({ id: campaignRoutesTable.id })
        .from(campaignRoutesTable)
        .innerJoin(campaignsTable, eq(campaignsTable.id, campaignRoutesTable.campaignId))
        .where(and(
          eq(campaignRoutesTable.organizationId, req.organizationId!),
          eq(campaignRoutesTable.phoneNumberId, existing.id),
          inArray(campaignsTable.status, ["Draft", "Ready", "Scheduled", "Running", "Paused"]),
        )).limit(1);
      if (inUse) return "in_use" as const;

      const [archived] = await tx.update(phoneNumbersTable).set({
        archivedAt: new Date(),
        status: "Pending",
        setupState: "action_required",
        setupError: "Archived in Wabista. Explicit restore required.",
        sendingCredentialId: null,
      }).where(and(
        eq(phoneNumbersTable.id, existing.id),
        eq(phoneNumbersTable.organizationId, req.organizationId!),
        isNull(phoneNumbersTable.archivedAt),
      )).returning({ id: phoneNumbersTable.id });
      if (!archived) throw new Error("Phone archive lost its row lock");
      return "archived" as const;
    });

    if (outcome === "missing") {
      res.status(404).json({ error: "Phone number not found" });
      return;
    }
    if (outcome === "in_use") {
      res.status(409).json({
        code: "phone_in_campaign",
        error: "Finish or cancel active campaigns and remove this sender from draft/ready campaigns before archiving.",
      });
      return;
    }
    // Idempotent DELETE: a second archive request succeeds without touching
    // the database record or its history.
    res.status(204).send();
  },
);

export default router;
