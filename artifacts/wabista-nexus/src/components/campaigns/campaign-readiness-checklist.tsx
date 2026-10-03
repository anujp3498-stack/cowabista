import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { getGetCampaignReadinessQueryKey, useGetCampaignReadiness } from "@workspace/api-client-react"

// Proactive readiness checklist. Reads GET .../campaigns/:id/readiness,
// which runs the exact same validateCampaignReady() rule set Plan/Execute
// enforce, so a manager sees precisely what blocks a launch before clicking
// Plan. Only meaningful pre-launch (Draft/Ready).
export function CampaignReadinessChecklist({
  organizationId,
  campaignId,
  active,
}: {
  organizationId: number | undefined
  campaignId: number
  active: boolean
}) {
  const { data: readiness, isLoading } = useGetCampaignReadiness(organizationId as number, campaignId, {
    query: {
      queryKey: getGetCampaignReadinessQueryKey(organizationId as number, campaignId),
      refetchInterval: active ? 5000 : false,
    },
  })

  if (!organizationId || !active || isLoading || !readiness) return null

  if (readiness.ready) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
        data-testid={`panel-readiness-${campaignId}`}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span className="font-medium">Ready to plan and launch</span>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-amber-600/30 bg-amber-500/10 p-3 space-y-1.5" data-testid={`panel-readiness-${campaignId}`}>
      <div className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {readiness.errors.length} readiness issue{readiness.errors.length === 1 ? "" : "s"} to resolve
      </div>
      <ul className="space-y-1 pl-6 list-disc text-xs text-muted-foreground">
        {readiness.errors.map((error, index) => (
          <li key={index} data-testid={`text-readiness-issue-${campaignId}-${index}`}>{error}</li>
        ))}
      </ul>
    </div>
  )
}
