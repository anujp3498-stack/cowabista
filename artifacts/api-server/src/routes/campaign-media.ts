import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { campaignsTable, db } from "@workspace/db";
import {
  RequestCampaignImageUploadBody,
  RequestCampaignImageUploadParams,
  RequestCampaignImageUploadResponse,
} from "@workspace/api-zod";
import {
  attachOrgContext,
  requireActiveOrganization,
  requireAuth,
  requireRole,
} from "../middlewares/auth";
import { createPrivateUploadUrl } from "../lib/object-storage";

const router: IRouter = Router();

const extensionByContentType: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

router.post(
  "/organizations/:organizationId/campaigns/:campaignId/template-mapping-image-upload",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = RequestCampaignImageUploadParams.safeParse(req.params);
    const body = RequestCampaignImageUploadBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: !params.success ? params.error.message : body.error?.message,
      });
      return;
    }
    if (!body.data.contentType.toLowerCase().startsWith("image/")) {
      res.status(400).json({ error: "Only image uploads are supported" });
      return;
    }
    const [campaign] = await db
      .select({ id: campaignsTable.id })
      .from(campaignsTable)
      .where(and(
        eq(campaignsTable.id, params.data.campaignId),
        eq(campaignsTable.organizationId, params.data.organizationId),
      ));
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const contentType = body.data.contentType.toLowerCase();
    const extension = extensionByContentType[contentType] ?? "image";
    const relativePath =
      `organizations/${params.data.organizationId}/campaigns/${campaign.id}/template-images/${randomUUID()}.${extension}`;
    const upload = await createPrivateUploadUrl(relativePath);
    res.json(RequestCampaignImageUploadResponse.parse(upload));
  },
);

export default router;