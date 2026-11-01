// Campaign modules: Normal ("standard") and Rocket ("rocket") campaigns are
// two separate products in the app, with their own list, routes, "new"
// flow and steps, on one shared engine. This module is the one place that
// says which paths, steps and words each module uses, so a page never
// links from one module into the other. Pure and dependency-free (unit
// tested with node --experimental-strip-types).

export type CampaignModule = "standard" | "rocket"
export type CampaignStepKey = "audience" | "message" | "delivery" | "review"

export type CampaignStep = { key: CampaignStepKey; label: string }

export type CampaignModuleInfo = {
  module: CampaignModule
  /** List page; a campaign lives at `${basePath}/:id`, its steps at `${basePath}/:id/<step>`. */
  basePath: string
  title: string
  /** "campaign" / "Rocket campaign", for sentences. */
  noun: string
  newLabel: string
  newPath: string
  draftName: string
  steps: readonly CampaignStep[]
}

export const CAMPAIGN_MODULES: Readonly<Record<CampaignModule, CampaignModuleInfo>> = {
  standard: {
    module: "standard",
    basePath: "/campaigns",
    title: "Campaigns",
    noun: "campaign",
    newLabel: "New campaign",
    newPath: "/campaigns/new",
    draftName: "Untitled campaign",
    steps: [
      { key: "audience", label: "Audience" },
      { key: "message", label: "Message" },
      { key: "review", label: "Review & Launch" },
    ],
  },
  rocket: {
    module: "rocket",
    basePath: "/rocket-campaigns",
    title: "Rocket Campaigns",
    noun: "Rocket campaign",
    newLabel: "New Rocket campaign",
    newPath: "/rocket-campaigns/new",
    draftName: "Untitled Rocket campaign",
    steps: [
      { key: "audience", label: "Audience" },
      // Step names match the server's guidance ("... in the Message step",
      // "... in the Delivery step"); each page explains what it sets.
      { key: "message", label: "Message" },
      { key: "delivery", label: "Delivery" },
      { key: "review", label: "Review & Launch" },
    ],
  },
}

export function isCampaignModule(value: unknown): value is CampaignModule {
  return value === "standard" || value === "rocket"
}

export function moduleInfo(module: CampaignModule): CampaignModuleInfo {
  return CAMPAIGN_MODULES[module]
}

/** The module a campaign belongs to (the API always returns a type; anything else is treated as Normal). */
export function moduleOf(campaign: { campaignType?: string | null }): CampaignModule {
  return campaign.campaignType === "rocket" ? "rocket" : "standard"
}

/**
 * A campaign created before campaign types (campaignTypeInferred) keeps the
 * full historical builder in either module: Audience, Message, Delivery,
 * Review (no module rule applies to it, and it may still need to choose a
 * distribution).
 */
const LEGACY_STANDARD_STEPS: readonly CampaignStep[] = [
  { key: "audience", label: "Audience" },
  { key: "message", label: "Message" },
  { key: "delivery", label: "Delivery" },
  { key: "review", label: "Review & Launch" },
]

export function stepsFor(module: CampaignModule, inferred = false): readonly CampaignStep[] {
  if (inferred && module === "standard") return LEGACY_STANDARD_STEPS
  return CAMPAIGN_MODULES[module].steps
}

export function hasStep(module: CampaignModule, step: CampaignStepKey, inferred = false): boolean {
  return stepsFor(module, inferred).some((candidate) => candidate.key === step)
}

/** `${basePath}/:id`, or a step of it; `tab` adds `?tab=`. */
export function campaignHref(module: CampaignModule, campaignId: number, step?: CampaignStepKey | null, tab?: string): string {
  const base = `${CAMPAIGN_MODULES[module].basePath}/${campaignId}`
  const path = step ? `${base}/${step}` : base
  return tab ? `${path}?tab=${encodeURIComponent(tab)}` : path
}

export function stepIndex(module: CampaignModule, step: CampaignStepKey, inferred = false): number {
  return stepsFor(module, inferred).findIndex((candidate) => candidate.key === step)
}

export function nextStep(module: CampaignModule, step: CampaignStepKey, inferred = false): CampaignStep | null {
  const steps = stepsFor(module, inferred)
  const index = steps.findIndex((candidate) => candidate.key === step)
  return index >= 0 && index + 1 < steps.length ? steps[index + 1]! : null
}

export function previousStep(module: CampaignModule, step: CampaignStepKey, inferred = false): CampaignStep | null {
  const steps = stepsFor(module, inferred)
  const index = steps.findIndex((candidate) => candidate.key === step)
  return index > 0 ? steps[index - 1]! : null
}

/**
 * Where a page for (route module, step) must send a campaign of another
 * module or a step its module does not have; null = render here. A Normal
 * campaign has no Delivery step: its speed is on Review.
 */
export function moduleRedirect(routeModule: CampaignModule, campaign: { id: number; campaignType?: string | null; campaignTypeInferred?: boolean }, step: CampaignStepKey | null): string | null {
  // A campaign created before types has only an inferred module (from its
  // route count, which changes as its setup changes): it renders wherever it
  // was opened, with every step, and is never bounced between modules.
  if (campaign.campaignTypeInferred) return null
  const actual = moduleOf(campaign)
  const target = step && !hasStep(actual, step) ? "review" : step
  if (actual === routeModule && target === step) return null
  return campaignHref(actual, campaign.id, target)
}

/** Message step rule per module: a Normal campaign sends from one number with one template. */
export function selectionLimit(module: CampaignModule): { senders: number | null; templates: number | null } {
  return module === "standard" ? { senders: 1, templates: 1 } : { senders: null, templates: null }
}

/** Toggle an id in a selection, honouring a module limit (limit 1 = choosing replaces). */
export function toggleWithLimit(list: readonly number[], id: number, checked: boolean, limit: number | null): number[] {
  if (!checked) return list.filter((value) => value !== id)
  if (list.includes(id)) return [...list]
  if (limit === 1) return [id]
  if (limit !== null && list.length >= limit) return [...list]
  return [...list, id]
}
