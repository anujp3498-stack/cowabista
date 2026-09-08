import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, phoneNumbersTable, wabasTable } from "@workspace/db";
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
  if (row.wabaId) {
    const [waba] = await db
      .select()
      .from(wabasTable)
      .where(eq(wabasTable.id, row.wabaId));
    wabaExternalId = waba?.externalId ?? null;
  }
  return { ...row, wabaExternalId };
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
      .where(eq(phoneNumbersTable.organizationId, req.organizationId!))
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

    const [deleted] = await db
      .delete(phoneNumbersTable)
      .where(
        and(
          eq(phoneNumbersTable.id, params.data.phoneNumberId),
          eq(phoneNumbersTable.organizationId, req.organizationId!),
        ),
      )
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Phone number not found" });
      return;
    }

    res.status(204).send();
  },
);

export default router;
