import { Link } from "wouter"
import { cn } from "@/lib/utils"

// The campaign-building steps that exist today (V2-06B). Review & Launch
// comes with V2-06C and is deliberately not shown until it works.
export const CAMPAIGN_STEPS = [
  { key: "audience", label: "Audience", path: "audience" },
  { key: "message", label: "Message", path: "message" },
  { key: "delivery", label: "Delivery", path: "delivery" },
] as const

export type CampaignStepKey = (typeof CAMPAIGN_STEPS)[number]["key"]

export function CampaignSteps({ campaignId, current }: { campaignId: number; current: CampaignStepKey }) {
  return (
    <nav aria-label="Campaign steps" data-testid="campaign-steps">
      <ol className="flex flex-wrap items-center gap-2 text-xs">
        {CAMPAIGN_STEPS.map((step, index) => {
          const active = step.key === current
          return (
            <li key={step.key} className="flex items-center gap-2">
              {index > 0 ? <span aria-hidden="true" className="text-muted-foreground">/</span> : null}
              <Link
                href={`/campaigns/${campaignId}/${step.path}`}
                aria-current={active ? "step" : undefined}
                className={cn("rounded-full border px-2.5 py-0.5", active ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
                data-testid={`step-${step.key}`}
              >
                Step {index + 1}: {step.label}
              </Link>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
