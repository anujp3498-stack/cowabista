import { Link } from "wouter"
import { cn } from "@/lib/utils"
import { campaignHref, stepsFor, type CampaignStepKey } from "@/lib/campaign-module"
import { useCampaignModule } from "@/components/campaigns/campaign-module-context"

// The campaign-building steps of the current module: Normal is Audience ->
// Message -> Review & Launch; Rocket adds Delivery (speed per number and distribution) before Review.
// A campaign created before types keeps all four.
export type { CampaignStepKey }

export function CampaignSteps({ campaignId, current, inferred = false }: { campaignId: number; current: CampaignStepKey; inferred?: boolean }) {
  const { module } = useCampaignModule()
  // A campaign created before types keeps every step (lib/campaign-module.ts).
  const steps = stepsFor(module, inferred)
  return (
    <nav aria-label="Campaign steps" data-testid="campaign-steps">
      <ol className="flex flex-wrap items-center gap-2 text-xs">
        {steps.map((step, index) => {
          const active = step.key === current
          return (
            <li key={step.key} className="flex items-center gap-2">
              {index > 0 ? <span aria-hidden="true" className="text-muted-foreground">/</span> : null}
              <Link
                href={campaignHref(module, campaignId, step.key)}
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
