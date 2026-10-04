import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignTemplateSelectionsTable,
  campaignsTable,
  db,
  phoneNumbersTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import {
  CreateCampaignRouteBody,
  CreateCampaignRouteResponse,
  ConfigureRocketCampaignBody,
  ConfigureRocketCampaignParams,
  ConfigureRocketCampaignResponse,
  DeleteCampaignRouteParams,
  ListCampaignRoutesQueryParams,
  ListCampaignRoutesResponse,
  UpdateCampaignRouteBody,
  UpdateCampaignRouteParams,
  UpdateCampaignRouteResponse,
} from "@workspace/api-zod";
import {
  attachOrgContext,
  requireActiveOrganization,
  requireAuth,
  requireRole,
} from "../middlewares/auth";
import { withCampaignLifecycleLock } from "../services/campaign-planning";
import { assertSetupEditable } from "../services/campaign-import-lifecycle";
import { decidePair, derivedRouteWabaId, loadCompatibilityState, pairSendersToTemplates } from "../services/template-eligibility";

const router: IRouter = Router();

async function serializeRoute(row: typeof campaignRoutesTable.$inferSelect) {
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, row.campaignId));
  const [phoneNumber] = await db
    .select()
    .from(phoneNumbersTable)
    .where(eq(phoneNumbersTable.id, row.phoneNumberId));
  const template = row.templateId
    ? (
        await db
          .select()
          .from(templatesTable)
          .where(eq(templatesTable.id, row.templateId))
      )[0]
    : null;
  const waba = phoneNumber?.wabaId
    ? (
        await db
          .select()
          .from(wabasTable)
          .where(eq(wabasTable.id, phoneNumber.wabaId))
      )[0]
    : null;

  return {
    ...row,
    campaignName: campaign?.name ?? "Unknown campaign",
    phoneNumber: phoneNumber?.phone ?? "Unknown number",
    wabaExternalId: waba?.externalId ?? null,
    templateName: template?.name ?? null,
  };
}

/**
 * Confirms the campaign, phone number and (optional) template referenced by
 * a route all belong to the caller's organization, the TPS is within the
 * phone's provider cap, and -- when a template is given -- the pair passes
 * the ONE shared sender-template decision (template-eligibility.ts). There
 * is no raw wabaId comparison here any more: the WABA rule, the provider
 * evidence, the credential binding and the local/mock exception all live
 * in that decision. The route's stored wabaId is derived from the phone.
 */
export async function assertOwnedByOrg(
  organizationId: number,
  campaignId: number,
  phoneNumberId: number,
  templateId: number | null | undefined,
  configuredTps: number,
): Promise<string | null> {
  const [campaign] = await db
    .select({ id: campaignsTable.id })
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.organizationId, organizationId),
      ),
    );
  if (!campaign) return "Campaign not found in this organization";

  const state = await loadCompatibilityState(organizationId, { phoneIds: [phoneNumberId], templateIds: templateId == null ? [] : [templateId] });
  const phoneNumber = state.phones.get(phoneNumberId);
  if (!phoneNumber) return "Phone number not found in this organization";
  if (!Number.isInteger(configuredTps) || configuredTps < 1) {
    return "Configured TPS must be a positive integer";
  }
  if (!Number.isInteger(phoneNumber.tpsLimit) || phoneNumber.tpsLimit < 1) {
    return "Selected phone number does not have a valid provider-approved TPS limit";
  }
  if (configuredTps > phoneNumber.tpsLimit) {
    return `Configured TPS cannot exceed this phone number's provider limit of ${phoneNumber.tpsLimit}`;
  }

  if (templateId != null) {
    if (!state.templates.has(templateId)) return "Template not found in this organization";
    const decision = decidePair(state, phoneNumberId, templateId);
    if (!decision.eligible) return `${decision.message} (${decision.code})`;
  }

  return null;
}

router.get(
  "/campaign-routes",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const query = ListCampaignRoutesQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }

    const conditions = [
      eq(campaignRoutesTable.organizationId, req.organizationId!),
    ];
    if (query.data.campaignId != null) {
      conditions.push(eq(campaignRoutesTable.campaignId, query.data.campaignId));
    }

    const rows = await db
      .select()
      .from(campaignRoutesTable)
      .where(and(...conditions))
      .orderBy(desc(campaignRoutesTable.createdAt));

    const serialized = await Promise.all(rows.map(serializeRoute));
    res.json(ListCampaignRoutesResponse.parse(serialized));
  },
);

router.post(
  "/campaign-routes",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const body = CreateCampaignRouteBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const ownershipError = await assertOwnedByOrg(
      req.organizationId!,
      body.data.campaignId,
      body.data.phoneNumberId,
      body.data.templateId,
      body.data.configuredTps ?? 1,
    );
    if (ownershipError) {
      res.status(400).json({ error: ownershipError });
      return;
    }

    let route: typeof campaignRoutesTable.$inferSelect | undefined;
    let routeError: string | undefined;
    let routeErrorCode: string | undefined;
    // Share the same per-campaign advisory lock plan()/execute() use (see
    // withCampaignLifecycleLock's doc comment). A route defines the exact
    // TPS/template a plan freezes; without this lock, adding a route here
    // could commit in the middle of planCampaignLocked's own separate reads
    // of the routes table, letting a snapshot freeze a route set that never
    // existed as a whole in the live table.
    await withCampaignLifecycleLock(body.data.campaignId, (scopedDb) => scopedDb.transaction(async (tx) => {
      // V2-05A: setup is editable before execution (Draft, or Ready with no
      // execution history -- the stale plan is superseded and the campaign
      // returns to Draft in this same transaction); imported recipients are
      // kept. Refused during an active import and once any job exists.
      const editable = await assertSetupEditable(tx, req.organizationId!, body.data.campaignId, req.authUser?.id);
      if (!editable.ok) {
        routeError = editable.message;
        routeErrorCode = editable.code;
        return;
      }
      [route] = await tx.insert(campaignRoutesTable)
        .values({ ...body.data, organizationId: req.organizationId!, wabaId: await derivedRouteWabaId(req.organizationId!, body.data.phoneNumberId) })
        .returning();
    }));
    if (routeError) {
      res.status(409).json({ error: routeError, ...(routeErrorCode ? { code: routeErrorCode } : {}) });
      return;
    }
    if (!route) {
      res.status(500).json({ error: "Unable to create campaign route" });
      return;
    }

    res
      .status(201)
      .json(CreateCampaignRouteResponse.parse(await serializeRoute(route)));
  },
);

router.put(
  "/organizations/:organizationId/campaigns/:campaignId/rocket-setup",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = ConfigureRocketCampaignParams.safeParse(req.params);
    const body = ConfigureRocketCampaignBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: params.error?.message ?? body.error?.message });
      return;
    }

    const numberIds = body.data.numbers.map((number) => number.phoneNumberId);
    const templateIds = body.data.templateIds;
    if (new Set(numberIds).size !== numberIds.length) {
      res.status(400).json({ error: "Each phone number can only be selected once" });
      return;
    }
    if (new Set(templateIds).size !== templateIds.length) {
      res.status(400).json({ error: "Each template can only be selected once" });
      return;
    }
    if (numberIds.length < templateIds.length) {
      res.status(400).json({
        error: "Select at least as many phone numbers as templates so every template has a sending route",
      });
      return;
    }

    let configuredRoutes: Array<typeof campaignRoutesTable.$inferSelect> = [];
    let setupError: string | undefined;
    let setupErrorCode: string | undefined;
    await withCampaignLifecycleLock(params.data.campaignId, (scopedDb) =>
      scopedDb.transaction(async (tx) => {
        const [campaign] = await tx
          .select({ id: campaignsTable.id, status: campaignsTable.status })
          .from(campaignsTable)
          .where(
            and(
              eq(campaignsTable.id, params.data.campaignId),
              eq(campaignsTable.organizationId, params.data.organizationId),
            ),
          )
          .for("update");
        if (!campaign) {
          setupError = "Campaign not found";
          return;
        }
        if (!["Draft", "Ready"].includes(campaign.status)) {
          setupError = "Rocket setup can only change while the campaign is draft or ready";
          return;
        }

        // V2-05A: pre-execution setup edits are allowed after an import;
        // a Ready campaign's plan is superseded (back to Draft) here.
        const editable = await assertSetupEditable(tx, params.data.organizationId, params.data.campaignId, req.authUser?.id);
        if (!editable.ok) {
          setupError = editable.message;
          setupErrorCode = editable.code;
          return;
        }

        // ONE shared compatibility evaluation for the selection (A-C), then
        // the campaign's own rules (D): TPS caps and coverage.
        const state = await loadCompatibilityState(params.data.organizationId, { phoneIds: numberIds, templateIds });
        if (numberIds.some((id) => !state.phones.has(id))) {
          setupError = "Every selected phone number must belong to this organization";
          return;
        }
        if (templateIds.some((id) => !state.templates.has(id))) {
          setupError = "Every selected template must belong to this organization";
          return;
        }
        const tpsByPhone = new Map(
          body.data.numbers.map((number) => [number.phoneNumberId, number.configuredTps]),
        );
        for (const phoneId of numberIds) {
          const phone = state.phones.get(phoneId)!;
          const configuredTps = tpsByPhone.get(phoneId)!;
          if (phone.status !== "Connected") {
            setupError = "Only connected phone numbers can be used in Rocket campaigns";
            return;
          }
          if (configuredTps > phone.tpsLimit) {
            setupError = `Configured TPS cannot exceed phone ${phone.id}'s provider limit of ${phone.tpsLimit}`;
            return;
          }
        }
        const notApproved = templateIds.filter((id) => state.templates.get(id)!.status !== "Approved");
        if (notApproved.length) {
          setupError = "Only approved templates can be used in Rocket campaigns";
          return;
        }
        // Deterministic pairing over the compatibility graph: covers every
        // selected template when the one-route-per-number model allows it,
        // in request order; no partial setup is written on failure.
        const pairing = pairSendersToTemplates(numberIds, templateIds, (phoneId, templateId) => decidePair(state, phoneId, templateId).eligible);
        if (!pairing.ok) {
          const reasons = [...new Set(pairing.uncoveredTemplateIds.flatMap((templateId) => numberIds.map((phoneId) => decidePair(state, phoneId, templateId)).filter((d) => !d.eligible).map((d) => d.message)))];
          setupError = `${pairing.message}${reasons.length ? ` Reasons: ${reasons.join("; ")}.` : ""}`;
          return;
        }
        const routeValues = pairing.assignments.map(({ phoneNumberId, templateId }) => ({
          organizationId: params.data.organizationId,
          campaignId: params.data.campaignId,
          phoneNumberId,
          templateId,
          wabaId: state.phones.get(phoneNumberId)!.wabaId,
          priority: body.data.priority ?? "Normal",
          configuredTps: tpsByPhone.get(phoneNumberId)!,
          currentTps: 0,
          queueDepth: 0,
          status: "Active",
        }));

        await tx
          .delete(campaignRoutesTable)
          .where(
            and(
              eq(campaignRoutesTable.organizationId, params.data.organizationId),
              eq(campaignRoutesTable.campaignId, params.data.campaignId),
            ),
          );
        await tx
          .delete(campaignTemplateSelectionsTable)
          .where(
            and(
              eq(campaignTemplateSelectionsTable.organizationId, params.data.organizationId),
              eq(campaignTemplateSelectionsTable.campaignId, params.data.campaignId),
            ),
          );
        await tx.insert(campaignTemplateSelectionsTable).values(
          templateIds.map((templateId) => ({
            organizationId: params.data.organizationId,
            campaignId: params.data.campaignId,
            templateId,
          })),
        );
        configuredRoutes = await tx
          .insert(campaignRoutesTable)
          .values(routeValues)
          .returning();
        await tx
          .update(campaignsTable)
          .set({ status: "Draft" })
          .where(
            and(
              eq(campaignsTable.id, params.data.campaignId),
              eq(campaignsTable.organizationId, params.data.organizationId),
            ),
          );
      }),
    );

    if (setupError) {
      res.status(409).json({ error: setupError, ...(setupErrorCode ? { code: setupErrorCode } : {}) });
      return;
    }
    const routes = await Promise.all(configuredRoutes.map(serializeRoute));
    res.json(
      ConfigureRocketCampaignResponse.parse({
        campaignId: params.data.campaignId,
        numberCount: body.data.numbers.length,
        templateCount: body.data.templateIds.length,
        aggregateTps: body.data.numbers.reduce(
          (sum, number) => sum + number.configuredTps,
          0,
        ),
        routes,
      }),
    );
  },
);

router.patch(
  "/campaign-routes/:routeId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = UpdateCampaignRouteParams.safeParse(req.params);
    const body = UpdateCampaignRouteBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res
        .status(400)
        .json({ error: params.error?.message ?? body.error?.message });
      return;
    }

    const [existing] = await db
      .select()
      .from(campaignRoutesTable)
      .where(
        and(
          eq(campaignRoutesTable.id, params.data.routeId),
          eq(campaignRoutesTable.organizationId, req.organizationId!),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Campaign route not found" });
      return;
    }
    if (body.data.campaignId !== undefined && body.data.campaignId !== existing.campaignId) {
      res.status(409).json({ error: "Routes cannot be moved between campaigns" });
      return;
    }

    const ownershipError = await assertOwnedByOrg(
      req.organizationId!,
      body.data.campaignId ?? existing.campaignId,
      body.data.phoneNumberId ?? existing.phoneNumberId,
      body.data.templateId !== undefined
        ? body.data.templateId
        : existing.templateId,
      body.data.configuredTps ?? existing.configuredTps,
    );
    if (ownershipError) {
      res.status(400).json({ error: ownershipError });
      return;
    }

    const topologyChanged =
      (body.data.phoneNumberId !== undefined && body.data.phoneNumberId !== existing.phoneNumberId) ||
      (body.data.templateId !== undefined && body.data.templateId !== existing.templateId);
    const tpsChanged =
      body.data.configuredTps !== undefined &&
      body.data.configuredTps !== existing.configuredTps;
    let updated: typeof campaignRoutesTable.$inferSelect | undefined;
    let routeError: string | undefined;
    let routeErrorCode: string | undefined;
    if (topologyChanged || tpsChanged) {
      // Share the same per-campaign advisory lock plan()/execute() use (see
      // withCampaignLifecycleLock's doc comment). A route's TPS/phone/
      // template is exactly what a plan freezes; without this lock, this
      // change could commit in the middle of planCampaignLocked's own
      // separate reads of the routes table, letting a snapshot freeze a
      // route set that combines a validated-then-superseded configuration
      // with this edit -- reported Ready, but not actually reproducible or
      // safe.
      await withCampaignLifecycleLock(existing.campaignId, (scopedDb) => scopedDb.transaction(async (tx) => {
        const [lockedCampaign] = await tx.select({
          id: campaignsTable.id,
          status: campaignsTable.status,
        }).from(campaignsTable).where(and(
          eq(campaignsTable.id, existing.campaignId),
          eq(campaignsTable.organizationId, req.organizationId!),
        )).for("update");
        if (!lockedCampaign) {
          routeError = "Campaign not found";
          return;
        }
        if (tpsChanged && !["Draft", "Ready", "Scheduled", "Paused"].includes(lockedCampaign.status)) {
          routeError = "Route TPS can only change while the campaign is draft, ready, scheduled, or paused";
          return;
        }
        if (topologyChanged) {
          const editable = await assertSetupEditable(tx, req.organizationId!, existing.campaignId, req.authUser?.id);
          if (!editable.ok) {
            routeError = editable.message;
            routeErrorCode = editable.code;
            return;
          }
        }
        [updated] = await tx.update(campaignRoutesTable).set({
          ...body.data,
          wabaId: await derivedRouteWabaId(req.organizationId!, body.data.phoneNumberId ?? existing.phoneNumberId),
        })
          .where(and(
            eq(campaignRoutesTable.id, existing.id),
            eq(campaignRoutesTable.organizationId, req.organizationId!),
          )).returning();
      }));
    } else {
      // Re-assert the org predicate directly on the write, not just the
      // earlier read, so this can never affect another tenant's route.
      [updated] = await db.update(campaignRoutesTable).set(body.data)
        .where(and(
          eq(campaignRoutesTable.id, existing.id),
          eq(campaignRoutesTable.organizationId, req.organizationId!),
        )).returning();
    }
    if (routeError) {
      res.status(409).json({ error: routeError, ...(routeErrorCode ? { code: routeErrorCode } : {}) });
      return;
    }
    if (!updated) {
      res.status(404).json({ error: "Campaign route not found" });
      return;
    }

    res.json(UpdateCampaignRouteResponse.parse(await serializeRoute(updated)));
  },
);

router.delete(
  "/campaign-routes/:routeId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = DeleteCampaignRouteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [existing] = await db.select().from(campaignRoutesTable).where(and(
      eq(campaignRoutesTable.id, params.data.routeId),
      eq(campaignRoutesTable.organizationId, req.organizationId!),
    ));
    if (!existing) {
      res.status(404).json({ error: "Campaign route not found" });
      return;
    }
    let deleted: typeof campaignRoutesTable.$inferSelect | undefined;
    let routeError: string | undefined;
    let routeErrorCode: string | undefined;
    // Share the same per-campaign advisory lock plan()/execute() use (see
    // withCampaignLifecycleLock's doc comment), so this deletion can't
    // commit in the middle of planCampaignLocked's own separate reads of
    // the routes table.
    await withCampaignLifecycleLock(existing.campaignId, (scopedDb) => scopedDb.transaction(async (tx) => {
      await tx.select({ id: campaignsTable.id }).from(campaignsTable).where(and(
        eq(campaignsTable.id, existing.campaignId),
        eq(campaignsTable.organizationId, req.organizationId!),
      )).for("update");
      const editable = await assertSetupEditable(tx, req.organizationId!, existing.campaignId, req.authUser?.id);
      if (!editable.ok) {
        routeError = editable.message;
        routeErrorCode = editable.code;
        return;
      }
      [deleted] = await tx.delete(campaignRoutesTable).where(and(
        eq(campaignRoutesTable.id, existing.id),
        eq(campaignRoutesTable.organizationId, req.organizationId!),
      )).returning();
    }));
    if (routeError) {
      res.status(409).json({ error: routeError, ...(routeErrorCode ? { code: routeErrorCode } : {}) });
      return;
    }

    if (!deleted) {
      res.status(404).json({ error: "Campaign route not found" });
      return;
    }

    res.status(204).send();
  },
);

export default router;
