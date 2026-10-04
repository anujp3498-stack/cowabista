import {
  getUploadCampaignMediaUrl,
  type CampaignMediaAsset,
  type MessageMapping,
  type MessageRequirement,
  type MessageSetup,
  type MessageTemplate,
} from "@workspace/api-client-react"

// Client-side bookkeeping for the Message Studio editor (V2-05B). The
// server decides everything that matters -- compatibility (V2-04), what
// allocator v1 can run, mapping validity, resolved values -- and this
// module only edits the draft the user is about to save.

export type DraftSetup = {
  senderIds: number[]
  templateIds: number[]
  mappings: MessageMapping[]
}

export function draftFrom(setup: MessageSetup): DraftSetup {
  return {
    senderIds: [...setup.selection.senderPhoneNumberIds],
    templateIds: [...setup.selection.templateIds],
    mappings: setup.mappings.map((m) => ({ ...m })),
  }
}

export function sameDraft(a: DraftSetup, b: DraftSetup): boolean {
  const norm = (d: DraftSetup) => JSON.stringify({
    s: [...d.senderIds].sort((x, y) => x - y),
    t: [...d.templateIds].sort((x, y) => x - y),
    m: d.mappings.map((m) => [m.templateId, m.component, m.variable, m.source, m.sourceValue, m.mediaAssetId ?? null, m.optional ?? false, m.fallbackValue ?? null]).sort(),
  })
  return norm(a) === norm(b)
}

export function toggle(ids: number[], id: number, on: boolean): number[] {
  return on ? [...new Set([...ids, id])] : ids.filter((value) => value !== id)
}

export function mappingFor(draft: DraftSetup, templateId: number, requirement: MessageRequirement): MessageMapping | undefined {
  return draft.mappings.find((m) => m.templateId === templateId && m.component === requirement.component && m.variable === requirement.variable)
}

/** Replace (or remove, with null) one template's mapping for one slot. */
export function setMapping(draft: DraftSetup, templateId: number, requirement: MessageRequirement, next: Omit<MessageMapping, "templateId" | "component" | "variable"> | null): DraftSetup {
  const others = draft.mappings.filter((m) => !(m.templateId === templateId && m.component === requirement.component && m.variable === requirement.variable))
  return { ...draft, mappings: next ? [...others, { templateId, component: requirement.component, variable: requirement.variable, ...next }] : others }
}

/**
 * "Use for other templates": copies one template's mapping for a slot to
 * every other SELECTED template that has the same slot (a media header
 * only to templates of the same media kind) and does not map it yet. An
 * existing per-template mapping is never overwritten. The copies are
 * explicit rows the user then saves; nothing stays linked.
 */
export function shareMapping(draft: DraftSetup, templates: MessageTemplate[], fromTemplateId: number, requirement: MessageRequirement): { draft: DraftSetup; applied: number } {
  const source = mappingFor(draft, fromTemplateId, requirement)
  if (!source) return { draft, applied: 0 }
  let next = draft
  let applied = 0
  for (const template of templates) {
    if (template.templateId === fromTemplateId || !draft.templateIds.includes(template.templateId)) continue
    const slot = template.requirements.find((r) => r.key === requirement.key && (requirement.key !== "header:media" || r.mediaKind === requirement.mediaKind))
    if (!slot || mappingFor(next, template.templateId, slot)) continue
    next = setMapping(next, template.templateId, slot, { source: source.source, sourceValue: source.sourceValue, mediaAssetId: source.mediaAssetId ?? null, optional: source.optional ?? false, fallbackValue: source.fallbackValue ?? null })
    applied++
  }
  return { draft: next, applied }
}

/** Slots of a template with no usable mapping in the draft (save-independent hint; readiness is the authority). */
export function unmappedCount(draft: DraftSetup, template: MessageTemplate): number {
  return template.requirements.filter((r) => {
    const m = mappingFor(draft, template.templateId, r)
    return !m || !(m.source === "media_asset" ? m.mediaAssetId : m.sourceValue.trim())
  }).length
}

export const MEDIA_ACCEPT: Record<string, string> = {
  image: "image/jpeg,image/png",
  video: "video/mp4,video/3gpp",
  document: "application/pdf",
}

export type StudioRequestError = Error & { status: number; code?: string; details?: string[] }

/**
 * Raw-bytes upload of one campaign media file. Not the generated
 * `uploadCampaignMedia`, whose binary-body codegen JSON-encodes the Blob.
 */
export async function uploadCampaignMediaFile(organizationId: number, campaignId: number, file: File): Promise<CampaignMediaAsset> {
  const res = await fetch(getUploadCampaignMediaUrl(organizationId, campaignId), {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", "x-file-name": file.name },
    body: file,
  })
  const body = await res.json().catch(() => null) as { error?: string; code?: string; details?: string[] } | null
  if (!res.ok) {
    const error = new Error(body?.error ?? `Upload failed (HTTP ${res.status})`) as StudioRequestError
    error.status = res.status
    error.code = body?.code
    error.details = body?.details
    throw error
  }
  return body as unknown as CampaignMediaAsset
}

export function errorCodeOf(error: unknown): string | undefined {
  const data = (error as { data?: { code?: unknown } } | null)?.data
  if (data && typeof data.code === "string") return data.code
  const direct = (error as { code?: unknown } | null)?.code
  return typeof direct === "string" ? direct : undefined
}

export function errorDetailsOf(error: unknown): string[] {
  const data = (error as { data?: { details?: unknown } } | null)?.data
  return Array.isArray(data?.details) ? data!.details.filter((d): d is string => typeof d === "string") : []
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
