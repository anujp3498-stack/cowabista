import { Router, type IRouter, type Response } from "express";
import {
  GetCampaignPreflightParams,
  GetCampaignPreflightResponse,
  GetDeliverySetupParams,
  GetDeliverySetupResponse,
  GetLaunchProjectionParams,
  GetLaunchProjectionResponse,
  PreviewLaunchRecipientBody,
  PreviewLaunchRecipientParams,
  PreviewLaunchRecipientResponse,
  SaveDeliverySetupBody,
  SaveDeliverySetupParams,
  SaveDeliverySetupResponse,
} from "@workspace/api-zod";
import { attachOrgContext, requireActiveOrganization, requireAuth, requireRole } from "../middlewares/auth";
import { MessageStudioError } from "../services/message-studio-errors";
import { loadDeliverySetup, saveDeliverySetup } from "../services/campaign-delivery-setup";
import { getCampaignPreflight } from "../services/campaign-preflight-report";
import { getLaunchProjection, previewLaunchRecipient } from "../services/campaign-review";

// V2-06B Delivery step API. Reads need workspace membership; writes need the
// campaign-management role (manager+). Every query is scoped by the path
// organization (requireActiveOrganization matched it to the caller's active
// workspace); another workspace's campaign is simply not found.

const router: IRouter = Router();
const base = "/organizations/:organizationId/campaigns/:campaignId";

function fail(res: Response, error: unknown): void {
  if (error instanceof MessageStudioError) {
    res.status(error.status).json(error.toBody());
    return;
  }
  throw error;
}

router.get(`${base}/delivery-setup`, requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = GetDeliverySetupParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(GetDeliverySetupResponse.parse(await loadDeliverySetup(params.data.organizationId, params.data.campaignId)));
  } catch (error) { fail(res, error); }
});

router.put(`${base}/delivery-setup`, requireAuth, attachOrgContext, requireActiveOrganization, requireRole("manager"), async (req, res): Promise<void> => {
  const params = SaveDeliverySetupParams.safeParse(req.params);
  const body = SaveDeliverySetupBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request", code: "delivery_invalid" });
    return;
  }
  try {
    const saved = await saveDeliverySetup({
      organizationId: params.data.organizationId,
      campaignId: params.data.campaignId,
      actorUserId: req.authUser?.id,
      revision: body.data.revision,
      distributionMode: body.data.distributionMode,
      deliveryMode: body.data.deliveryMode,
      // The raw submitted settings (not the zod-stripped copy): the service
      // refuses unknown fields instead of silently ignoring them.
      deliverySettings: (req.body as { deliverySettings?: unknown }).deliverySettings,
    });
    res.json(SaveDeliverySetupResponse.parse(saved));
  } catch (error) { fail(res, error); }
});

// Structured preflight: a read (membership), never a write of any kind.
router.get(`${base}/preflight`, requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = GetCampaignPreflightParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(GetCampaignPreflightResponse.parse(await getCampaignPreflight(params.data.organizationId, params.data.campaignId)));
  } catch (error) { fail(res, error); }
});

// V2-06C Review & Launch reads (membership): an approximate projection and a
// one-recipient preview. Neither plans, allocates, creates jobs or bindings.
router.get(`${base}/review`, requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = GetLaunchProjectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(GetLaunchProjectionResponse.parse(await getLaunchProjection(params.data.organizationId, params.data.campaignId)));
  } catch (error) { fail(res, error); }
});

router.post(`${base}/review/preview`, requireAuth, attachOrgContext, requireActiveOrganization, async (req, res): Promise<void> => {
  const params = PreviewLaunchRecipientParams.safeParse(req.params);
  const body = PreviewLaunchRecipientBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request" });
    return;
  }
  try {
    res.json(PreviewLaunchRecipientResponse.parse(await previewLaunchRecipient(params.data.organizationId, params.data.campaignId, body.data.contactId)));
  } catch (error) { fail(res, error); }
});

export default router;
