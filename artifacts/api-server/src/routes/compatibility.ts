import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { campaignsTable, db } from "@workspace/db";
import {
  GetCampaignCompatibilityParams,
  GetCampaignCompatibilityResponse,
  GetWhatsAppCompatibilityBody,
  GetWhatsAppCompatibilityParams,
  GetWhatsAppCompatibilityResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { attachOrgContext, requireActiveOrganization, requireAuth } from "../middlewares/auth";
import { campaignSelectionIds } from "../services/campaign-preflight";
import { buildCompatibilityMatrix, CompatibilityInputError } from "../services/template-eligibility";

// V2-04 compatibility reads. Membership of the organization is enough to
// read (the same visibility as the numbers and templates themselves);
// nothing here writes, decrypts or calls the provider.

const router: IRouter = Router();
const readGuards = [requireAuth, attachOrgContext, requireActiveOrganization] as const;

router.post("/organizations/:organizationId/whatsapp/compatibility", ...readGuards, async (req, res): Promise<void> => {
  const params = GetWhatsAppCompatibilityParams.safeParse(req.params);
  const body = GetWhatsAppCompatibilityBody.safeParse(req.body ?? {});
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: "numberIds and templateIds must be integer arrays of at most 50 ids." }); return; }
  try {
    const matrix = await buildCompatibilityMatrix(params.data.organizationId, { phoneIds: body.data.numberIds, templateIds: body.data.templateIds });
    res.json(GetWhatsAppCompatibilityResponse.parse(matrix));
  } catch (error) {
    if (error instanceof CompatibilityInputError) { res.status(400).json({ error: error.message }); return; }
    logger.error({ organizationId: params.data.organizationId, err: error }, "compatibility matrix failed");
    res.status(500).json({ error: "Could not evaluate compatibility right now." });
  }
});

router.get("/organizations/:organizationId/campaigns/:campaignId/compatibility", ...readGuards, async (req, res): Promise<void> => {
  const params = GetCampaignCompatibilityParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [campaign] = await db.select({ id: campaignsTable.id }).from(campaignsTable)
    .where(and(eq(campaignsTable.id, params.data.campaignId), eq(campaignsTable.organizationId, params.data.organizationId)));
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  try {
    const ids = await campaignSelectionIds(params.data.organizationId, params.data.campaignId);
    if (!ids.phoneIds.length && !ids.templateIds.length) {
      res.json(GetCampaignCompatibilityResponse.parse({ evaluatedAt: new Date(), numbers: [], templates: [], incompatiblePairs: [], numbersWithoutTemplate: [], templatesWithoutNumber: [] }));
      return;
    }
    const matrix = await buildCompatibilityMatrix(params.data.organizationId, ids);
    res.json(GetCampaignCompatibilityResponse.parse(matrix));
  } catch (error) {
    if (error instanceof CompatibilityInputError) { res.status(400).json({ error: error.message }); return; }
    logger.error({ organizationId: params.data.organizationId, campaignId: params.data.campaignId, err: error }, "campaign compatibility failed");
    res.status(500).json({ error: "Could not evaluate compatibility right now." });
  }
});

export default router;
