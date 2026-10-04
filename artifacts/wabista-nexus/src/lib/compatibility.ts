import { useQueries, useQuery } from "@tanstack/react-query"
import { getWhatsAppCompatibility, type EligibilityReasonCode, type WhatsAppCompatibility } from "@workspace/api-client-react"

// V2-04 compatibility reads. The server owns the decision; this module only
// fetches it in bounded, deduplicated requests keyed by the exact selection,
// so a response for an earlier selection (or another workspace) can never be
// applied to the current one: TanStack Query discards results whose key no
// longer matches.

export const COMPATIBILITY_MAX_IDS = 50

export const REASON_LABELS: Record<EligibilityReasonCode, string> = {
  eligible: "Can send",
  eligible_local_mock: "Can send (local test context)",
  not_found: "Not in this workspace",
  phone_sample: "Sample number",
  phone_not_connected: "Number not connected",
  phone_no_provider_identity: "Number has no provider id",
  phone_no_waba: "Number has no business account",
  credential_inactive: "Sending credential not active",
  credential_unbound: "Business account not linked to the sending credential",
  legacy_waba_not_claimed: "Not on the claimed business account",
  template_sample: "Sample template",
  template_not_provider_backed: "Local draft, not approved at Meta",
  template_not_approved: "Not approved at Meta",
  template_removed: "No longer at Meta",
  evidence_missing: "Not verified by a sync yet",
  evidence_not_sendable: "Last sync did not find it approved",
  waba_mismatch: "Different business accounts",
}

export function reasonLabel(code: EligibilityReasonCode | string): string {
  return (REASON_LABELS as Record<string, string>)[code] ?? code
}

function sortedUnique(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

export function compatibilityQueryKey(organizationId: number | undefined, numberIds: number[], templateIds: number[]) {
  return ["whatsapp-compatibility", organizationId ?? 0, sortedUnique(numberIds), sortedUnique(templateIds)] as const
}

/** One bounded request for an explicit selection (both sides at most 50). */
export function useCompatibility(organizationId: number | undefined, numberIds: number[], templateIds: number[], options: { enabled?: boolean } = {}) {
  const numbers = sortedUnique(numberIds).slice(0, COMPATIBILITY_MAX_IDS)
  const templates = sortedUnique(templateIds).slice(0, COMPATIBILITY_MAX_IDS)
  const enabled = Boolean(organizationId) && (numbers.length > 0 || templates.length > 0) && (options.enabled ?? true)
  return useQuery<WhatsAppCompatibility>({
    queryKey: compatibilityQueryKey(organizationId, numbers, templates),
    queryFn: () => getWhatsAppCompatibility(organizationId!, { numberIds: numbers.length ? numbers : undefined, templateIds: templates.length ? templates : undefined }),
    enabled,
    staleTime: 15_000,
  })
}

/**
 * "Can send" for a list of numbers (templates derived server-side per
 * business account), chunked into bounded requests. Returns per-number
 * eligible template ids and names, plus loading/error flags.
 */
export function useNumberCompatibility(organizationId: number | undefined, numberIds: number[]) {
  const ids = sortedUnique(numberIds)
  const chunks: number[][] = []
  for (let index = 0; index < ids.length; index += COMPATIBILITY_MAX_IDS) chunks.push(ids.slice(index, index + COMPATIBILITY_MAX_IDS))
  const queries = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: compatibilityQueryKey(organizationId, chunk, []),
      queryFn: () => getWhatsAppCompatibility(organizationId!, { numberIds: chunk }),
      enabled: Boolean(organizationId),
      staleTime: 15_000,
    })),
  })
  const byNumber = new Map<number, { eligibleTemplateIds: number[]; templateNames: string[]; code: string }>()
  for (const query of queries) {
    const data = query.data as WhatsAppCompatibility | undefined
    if (!data) continue
    const nameOf = new Map(data.templates.map((t) => [t.templateId, t.name]))
    for (const number of data.numbers) {
      byNumber.set(number.phoneNumberId, { eligibleTemplateIds: number.eligibleTemplateIds, templateNames: number.eligibleTemplateIds.map((id) => nameOf.get(id) ?? `#${id}`), code: number.code })
    }
  }
  return { byNumber, isLoading: queries.some((q) => q.isLoading), isError: queries.some((q) => q.isError) }
}
