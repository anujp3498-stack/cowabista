import { Router, type IRouter, type Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, mappingPresetsTable } from "@workspace/db";
import {
  ApplyMappingPresetBody,
  ApplyMappingPresetParams,
  ApplyMappingPresetResponse,
  CreateMappingPresetBody,
  CreateMappingPresetParams,
  CreateMappingPresetResponse,
  DeleteCampaignMediaParams,
  DeleteMappingPresetParams,
  DownloadCampaignMediaParams,
  GetMessageSetupParams,
  GetMessageSetupResponse,
  ListCampaignMediaParams,
  ListCampaignMediaResponse,
  ListMappingPresetsParams,
  ListMappingPresetsResponse,
  PreviewCampaignMessageBody,
  PreviewCampaignMessageParams,
  PreviewCampaignMessageResponse,
  SaveMessageSetupBody,
  SaveMessageSetupParams,
  SaveMessageSetupResponse,
  TestSendCampaignMessageBody,
  TestSendCampaignMessageParams,
  TestSendCampaignMessageResponse,
  UpdateMappingPresetBody,
  UpdateMappingPresetParams,
  UpdateMappingPresetResponse,
  UploadCampaignMediaHeader,
  UploadCampaignMediaParams,
  UploadCampaignMediaResponse,
} from "@workspace/api-zod";
import { attachOrgContext, requireActiveOrganization, requireAuth, requireRole } from "../middlewares/auth";
import { MessageStudioError } from "../services/message-studio-errors";
import { applyMappingPreset, loadMessageSetup, previewMessage, saveMessageSetup, validatePresetInput } from "../services/message-studio";
import {
  CAMPAIGN_MEDIA_LIMITS,
  deleteCampaignMediaAsset,
  listCampaignMediaAssets,
  loadCampaignMediaAsset,
  uploadCampaignMediaAsset,
} from "../services/campaign-media-assets";
import { configuredCampaignMediaStore } from "../services/campaign-media-storage";
import { testSendMessage } from "../services/message-test-send";

// V2-05B Message Studio API. Reads need workspace membership; every write
// needs the campaign-management role (manager+), the same as the existing
// campaign endpoints. Every query is scoped by the path organization, which
// requireActiveOrganization has already matched to the caller's active
// workspace; a campaign/template/number/asset/preset of another workspace
// is simply not found.

const router: IRouter = Router();
const base = "/organizations/:organizationId/campaigns/:campaignId";

function fail(res: Response, error: unknown): void {
  if (error instanceof MessageStudioError) {
    res.status(error.status).json(error.toBody());
    return;
  }
  throw error;
}

function badRequest(res: Response, message: string | undefined): void {
  res.status(400).json({ error: message ?? "Invalid request" });
}

router.get(`${base}/message-setup`, requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = GetMessageSetupParams.safeParse(req.params);
  if (!params.success) return badRequest(res, params.error.message);
  try {
    res.json(GetMessageSetupResponse.parse(await loadMessageSetup(params.data.organizationId, params.data.campaignId)));
  } catch (error) { fail(res, error); }
});

router.put(`${base}/message-setup`, requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = SaveMessageSetupParams.safeParse(req.params);
  const body = SaveMessageSetupBody.safeParse(req.body);
  if (!params.success || !body.success) return badRequest(res, !params.success ? params.error.message : body.error?.message);
  try {
    const saved = await saveMessageSetup({
      organizationId: params.data.organizationId,
      campaignId: params.data.campaignId,
      actorUserId: req.authUser?.id,
      revision: body.data.revision,
      senderPhoneNumberIds: body.data.senderPhoneNumberIds,
      templateIds: body.data.templateIds,
      mappings: body.data.mappings,
      distributionMode: body.data.distributionMode,
    });
    res.json(SaveMessageSetupResponse.parse(saved));
  } catch (error) { fail(res, error); }
});

router.post(`${base}/message-setup/preview`, requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = PreviewCampaignMessageParams.safeParse(req.params);
  const body = PreviewCampaignMessageBody.safeParse(req.body);
  if (!params.success || !body.success) return badRequest(res, !params.success ? params.error.message : body.error?.message);
  try {
    res.json(PreviewCampaignMessageResponse.parse(await previewMessage({ ...params.data, ...body.data })));
  } catch (error) { fail(res, error); }
});

router.post(`${base}/message-setup/apply-preset`, requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = ApplyMappingPresetParams.safeParse(req.params);
  const body = ApplyMappingPresetBody.safeParse(req.body);
  if (!params.success || !body.success) return badRequest(res, !params.success ? params.error.message : body.error?.message);
  try {
    res.json(ApplyMappingPresetResponse.parse(await applyMappingPreset({ ...params.data, ...body.data, actorUserId: req.authUser?.id })));
  } catch (error) { fail(res, error); }
});

router.post(`${base}/message-setup/test-send`, requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = TestSendCampaignMessageParams.safeParse(req.params);
  const body = TestSendCampaignMessageBody.safeParse(req.body);
  if (!params.success || !body.success) return badRequest(res, !params.success ? params.error.message : body.error?.message);
  if (body.data.recipientPhone === undefined && body.data.contactId === undefined) return badRequest(res, "Choose an audience contact or enter a test number");
  try {
    res.json(TestSendCampaignMessageResponse.parse(await testSendMessage({ ...params.data, ...body.data, actorUserId: req.authUser?.id })));
  } catch (error) { fail(res, error); }
});

router.get(`${base}/media`, requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = ListCampaignMediaParams.safeParse(req.params);
  if (!params.success) return badRequest(res, params.error.message);
  res.json(ListCampaignMediaResponse.parse(await listCampaignMediaAssets(params.data.organizationId, params.data.campaignId)));
});

router.post(`${base}/media`, requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = UploadCampaignMediaParams.safeParse(req.params);
  const headers = UploadCampaignMediaHeader.safeParse(req.headers);
  if (!params.success || !headers.success) return badRequest(res, !params.success ? params.error.message : headers.error?.message);
  const declared = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);
  try {
    const asset = await uploadCampaignMediaAsset({
      organizationId: params.data.organizationId,
      campaignId: params.data.campaignId,
      userId: req.authUser?.id ?? null,
      fileName: headers.data["x-file-name"],
      contentType: String(req.headers["content-type"] ?? ""),
      declaredLength: Number.isFinite(declared) ? declared : null,
      body: req as AsyncIterable<Buffer>,
    });
    res.status(201).json(UploadCampaignMediaResponse.parse(asset));
  } catch (error) {
    // Stop reading an oversized or refused body.
    if (error instanceof MessageStudioError && !req.readableEnded) req.resume();
    fail(res, error);
  }
});

router.delete(`${base}/media/:mediaAssetId`, requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = DeleteCampaignMediaParams.safeParse(req.params);
  if (!params.success) return badRequest(res, params.error.message);
  try {
    await deleteCampaignMediaAsset(params.data.organizationId, params.data.campaignId, params.data.mediaAssetId);
    res.status(204).end();
  } catch (error) { fail(res, error); }
});

router.get(`${base}/media/:mediaAssetId/content`, requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = DownloadCampaignMediaParams.safeParse(req.params);
  if (!params.success) return badRequest(res, params.error.message);
  const asset = await loadCampaignMediaAsset(params.data.organizationId, params.data.campaignId, params.data.mediaAssetId);
  const store = configuredCampaignMediaStore();
  if (!asset || asset.status !== "ready" || !store || !CAMPAIGN_MEDIA_LIMITS[asset.contentType]) {
    res.status(404).json({ error: "Media not found in this campaign" });
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", asset.contentType);
  res.setHeader("Content-Length", String(asset.byteLength));
  res.setHeader("Content-Disposition", `inline; filename="${asset.fileName.replace(/[^\w.() -]/g, "_")}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  const stream = store.stream(asset.storageKey);
  stream.on("error", () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
  stream.pipe(res);
});

router.get("/organizations/:organizationId/mapping-presets", requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = ListMappingPresetsParams.safeParse(req.params);
  if (!params.success) return badRequest(res, params.error.message);
  const rows = await db.select().from(mappingPresetsTable).where(eq(mappingPresetsTable.organizationId, params.data.organizationId)).orderBy(asc(mappingPresetsTable.name));
  res.json(ListMappingPresetsResponse.parse(rows));
});

router.post("/organizations/:organizationId/mapping-presets", requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = CreateMappingPresetParams.safeParse(req.params);
  const body = CreateMappingPresetBody.safeParse(req.body);
  if (!params.success || !body.success) return badRequest(res, !params.success ? params.error.message : body.error?.message);
  try {
    const preset = validatePresetInput(body.data);
    const [row] = await db.insert(mappingPresetsTable).values({ organizationId: params.data.organizationId, ...preset, createdBy: req.authUser?.id ?? null })
      .onConflictDoNothing({ target: [mappingPresetsTable.organizationId, mappingPresetsTable.name] }).returning();
    if (!row) throw new MessageStudioError("name_conflict", "A preset with this name already exists in this workspace", 409);
    res.status(201).json(CreateMappingPresetResponse.parse(row));
  } catch (error) { fail(res, error); }
});

router.put("/organizations/:organizationId/mapping-presets/:presetId", requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = UpdateMappingPresetParams.safeParse(req.params);
  const body = UpdateMappingPresetBody.safeParse(req.body);
  if (!params.success || !body.success) return badRequest(res, !params.success ? params.error.message : body.error?.message);
  try {
    const preset = validatePresetInput(body.data);
    const [row] = await db.update(mappingPresetsTable).set(preset).where(and(
      eq(mappingPresetsTable.id, params.data.presetId), eq(mappingPresetsTable.organizationId, params.data.organizationId),
    )).returning().catch((error: unknown) => {
      if ((error as { code?: string }).code === "23505") throw new MessageStudioError("name_conflict", "A preset with this name already exists in this workspace", 409);
      throw error;
    });
    if (!row) throw new MessageStudioError("not_found", "Preset not found in this workspace", 404);
    res.json(UpdateMappingPresetResponse.parse(row));
  } catch (error) { fail(res, error); }
});

router.delete("/organizations/:organizationId/mapping-presets/:presetId", requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = DeleteMappingPresetParams.safeParse(req.params);
  if (!params.success) return badRequest(res, params.error.message);
  const [row] = await db.delete(mappingPresetsTable).where(and(
    eq(mappingPresetsTable.id, params.data.presetId), eq(mappingPresetsTable.organizationId, params.data.organizationId),
  )).returning({ id: mappingPresetsTable.id });
  if (!row) {
    res.status(404).json({ error: "Preset not found in this workspace" });
    return;
  }
  res.status(204).end();
});

export default router;
