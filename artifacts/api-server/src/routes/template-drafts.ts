import express, { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateTemplateDraftBody,
  CreateTemplateDraftParams,
  CreateTemplateDraftResponse,
  DeleteTemplateDraftParams,
  GetTemplateDraftParams,
  GetTemplateDraftResponse,
  ListTemplateAuthoringWabasParams,
  ListTemplateAuthoringWabasResponse,
  ListTemplateDraftsParams,
  ListTemplateDraftsQueryParams,
  ListTemplateDraftsResponse,
  ReconcileTemplateDraftBody,
  ReconcileTemplateDraftParams,
  ReconcileTemplateDraftResponse,
  RefreshTemplateDraftStatusParams,
  RefreshTemplateDraftStatusResponse,
  SubmitTemplateDraftBody,
  SubmitTemplateDraftParams,
  SubmitTemplateDraftResponse,
  UpdateTemplateDraftBody,
  UpdateTemplateDraftParams,
  UpdateTemplateDraftResponse,
  UploadTemplateMediaParams,
  UploadTemplateMediaQueryParams,
  UploadTemplateMediaResponse,
} from "@workspace/api-zod";
import type { TemplateDraftContent } from "@workspace/db";
import { logger } from "../lib/logger";
import { attachOrgContext, requireActiveOrganization, requireAuth, requireRole } from "../middlewares/auth";
import { TemplateDraftError } from "../services/template-draft-errors";
import { createDraft, deleteDraft, listAuthoringWabas, listDrafts, loadDraft, updateDraft } from "../services/template-drafts";
import { TEMPLATE_MEDIA_MAX_BYTES, uploadTemplateMedia } from "../services/template-media";
import { reconcileDraft, refreshDraftStatus, submitDraft } from "../services/template-submission";

// V2-03B template authoring routes. Reading drafts needs membership of the
// organization; creating, editing, deleting, uploading media and
// submitting are owner/admin actions, enforced here with requireRole and
// never by the client. Every service call is scoped by the organization
// from the verified active-organization context.

const router: IRouter = Router();
const readGuards = [requireAuth, attachOrgContext, requireActiveOrganization] as const;
const writeGuards = [...readGuards, requireRole("admin")] as const;

function fail(res: Response, error: unknown, context: Record<string, unknown>, fallback: string): void {
  if (error instanceof TemplateDraftError) {
    res.status(error.httpStatus).json(error.toBody());
    return;
  }
  logger.error({ ...context, err: error }, fallback);
  res.status(500).json({ error: "Something went wrong. Try again.", code: "provider_unavailable" });
}

function userId(req: Request): number | null {
  return req.authUser?.id ?? null;
}

router.get("/organizations/:organizationId/template-authoring/wabas", ...readGuards, async (req, res): Promise<void> => {
  const params = ListTemplateAuthoringWabasParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    res.json(ListTemplateAuthoringWabasResponse.parse(await listAuthoringWabas(params.data.organizationId)));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId }, "listing authoring WABAs failed");
  }
});

router.get("/organizations/:organizationId/template-drafts", ...readGuards, async (req, res): Promise<void> => {
  const params = ListTemplateDraftsParams.safeParse(req.params);
  const query = ListTemplateDraftsQueryParams.safeParse(req.query);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  try {
    res.json(ListTemplateDraftsResponse.parse(await listDrafts(params.data.organizationId, query.data)));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId }, "listing template drafts failed");
  }
});

router.post("/organizations/:organizationId/template-drafts", ...writeGuards, async (req, res): Promise<void> => {
  const params = CreateTemplateDraftParams.safeParse(req.params);
  const body = CreateTemplateDraftBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: "Invalid draft.", code: "invalid_draft", fields: body.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) }); return; }
  try {
    const draft = await createDraft(params.data.organizationId, userId(req), { ...body.data, content: body.data.content as TemplateDraftContent });
    res.status(201).json(CreateTemplateDraftResponse.parse(draft));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId }, "creating template draft failed");
  }
});

router.get("/organizations/:organizationId/template-drafts/:draftId", ...readGuards, async (req, res): Promise<void> => {
  const params = GetTemplateDraftParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    res.json(GetTemplateDraftResponse.parse(await loadDraft(params.data.organizationId, params.data.draftId)));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId, draftId: params.data.draftId }, "loading template draft failed");
  }
});

router.patch("/organizations/:organizationId/template-drafts/:draftId", ...writeGuards, async (req, res): Promise<void> => {
  const params = UpdateTemplateDraftParams.safeParse(req.params);
  const body = UpdateTemplateDraftBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: "Invalid draft.", code: "invalid_draft", fields: body.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) }); return; }
  try {
    const draft = await updateDraft(params.data.organizationId, userId(req), params.data.draftId, { ...body.data, content: body.data.content as TemplateDraftContent | undefined });
    res.json(UpdateTemplateDraftResponse.parse(draft));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId, draftId: params.data.draftId }, "updating template draft failed");
  }
});

router.delete("/organizations/:organizationId/template-drafts/:draftId", ...writeGuards, async (req, res): Promise<void> => {
  const params = DeleteTemplateDraftParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    await deleteDraft(params.data.organizationId, params.data.draftId);
    res.status(204).end();
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId, draftId: params.data.draftId }, "deleting template draft failed");
  }
});

router.post("/organizations/:organizationId/template-drafts/:draftId/submit", ...writeGuards, async (req, res): Promise<void> => {
  const params = SubmitTemplateDraftParams.safeParse(req.params);
  const body = SubmitTemplateDraftBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: "expectedRevision is required.", code: "invalid_draft" }); return; }
  try {
    const result = await submitDraft({ organizationId: params.data.organizationId, draftId: params.data.draftId, expectedRevision: body.data.expectedRevision, userId: userId(req) });
    // An uncertain or refused outcome is reported on the draft itself with
    // a status that tells the client the request did not fully succeed.
    const status = result.attempt.state === "succeeded" ? 200 : result.attempt.state === "uncertain" ? 502 : 409;
    res.status(status).json(SubmitTemplateDraftResponse.parse(result.draft));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId, draftId: params.data.draftId }, "submitting template draft failed");
  }
});

router.post("/organizations/:organizationId/template-drafts/:draftId/reconcile", ...writeGuards, async (req, res): Promise<void> => {
  const params = ReconcileTemplateDraftParams.safeParse(req.params);
  const body = ReconcileTemplateDraftBody.safeParse(req.body ?? {});
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message, code: "invalid_draft" }); return; }
  try {
    const result = await reconcileDraft({ organizationId: params.data.organizationId, draftId: params.data.draftId, userId: userId(req), discardUnconfirmed: body.data.discardUnconfirmed });
    res.json(ReconcileTemplateDraftResponse.parse(result.draft));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId, draftId: params.data.draftId }, "reconciling template draft failed");
  }
});

router.post("/organizations/:organizationId/template-drafts/:draftId/refresh-status", ...writeGuards, async (req, res): Promise<void> => {
  const params = RefreshTemplateDraftStatusParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    res.json(RefreshTemplateDraftStatusResponse.parse(await refreshDraftStatus({ organizationId: params.data.organizationId, draftId: params.data.draftId, userId: userId(req) })));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId, draftId: params.data.draftId }, "refreshing template status failed");
  }
});

// Raw bytes only, bounded at the largest supported size. The global JSON
// parser ignores octet-stream bodies, so this is the only parser that
// touches them, and only after the guards passed.
const rawBody = express.raw({ type: () => true, limit: TEMPLATE_MEDIA_MAX_BYTES + 1024 });

router.post("/organizations/:organizationId/template-media", ...writeGuards, rawBody, async (req, res): Promise<void> => {
  const params = UploadTemplateMediaParams.safeParse(req.params);
  const query = UploadTemplateMediaQueryParams.safeParse(req.query);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!query.success) { res.status(400).json({ error: "wabaId, fileName and contentType are required.", code: "media_invalid" }); return; }
  const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array(0);
  try {
    const upload = await uploadTemplateMedia({
      organizationId: params.data.organizationId, userId: userId(req), wabaId: query.data.wabaId,
      fileName: query.data.fileName, contentType: query.data.contentType, bytes,
    });
    res.status(201).json(UploadTemplateMediaResponse.parse(upload));
  } catch (error) {
    fail(res, error, { organizationId: params.data.organizationId, wabaId: query.data.wabaId }, "uploading template media failed");
  }
});

export default router;
