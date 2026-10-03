import { Badge } from "@/components/ui/badge"
import { formatNumber } from "@/lib/utils"
import {
  getGetCampaignMonitoringQueryKey,
  useGetCampaignMonitoring,
  type CampaignMonitoring,
} from "@workspace/api-client-react"

// Polls the existing GET .../campaigns/:id/monitoring endpoint (queue /
// sent / delivered / failed counts, effective configured TPS after provider
// caps, retry / stale-lease / throttle signals). The 4-second refetch only
// runs while the campaign is Running; nothing here is a live stream.
export function useCampaignMonitoring(organizationId: number | undefined, campaignId: number, isRunning: boolean) {
  // Orval types `options.query` as a full UseQueryOptions (see the
  // orval-hooks-enabled-quirk memory), so re-supply queryKey alongside
  // refetchInterval to satisfy that without fighting the generated type.
  return useGetCampaignMonitoring(organizationId as number, campaignId, {
    query: {
      queryKey: getGetCampaignMonitoringQueryKey(organizationId as number, campaignId),
      refetchInterval: isRunning ? 4000 : false,
    },
  })
}

export function monitoringHasActivity(monitoring: CampaignMonitoring): boolean {
  return !(monitoring.valid === 0 && monitoring.queued === 0 && monitoring.sent === 0 && monitoring.failed === 0)
}

// Compact progress strip used on the Rocket campaign cards.
export function CampaignMonitoringPanel({
  organizationId,
  campaignId,
  isRunning,
}: {
  organizationId: number | undefined
  campaignId: number
  isRunning: boolean
}) {
  const { data: monitoring, isLoading } = useCampaignMonitoring(organizationId, campaignId, isRunning)

  if (!organizationId || isLoading || !monitoring) return null
  // Before a plan exists there's nothing sent/queued yet -- avoid showing an
  // all-zero progress panel that would read as "campaign is stuck".
  if (!monitoringHasActivity(monitoring)) return null

  const settled = monitoring.sent + monitoring.failed
  const progressPct = monitoring.valid > 0 ? Math.min(100, (settled / monitoring.valid) * 100) : 0
  const topErrors = Object.entries(monitoring.errorReasons).sort((a, b) => b[1] - a[1]).slice(0, 2)

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2" data-testid={`panel-monitoring-${campaignId}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">Send progress</span>
        <span className="font-mono" data-testid={`text-monitoring-progress-${campaignId}`}>
          {formatNumber(settled)} / {formatNumber(monitoring.valid)}
        </span>
      </div>
      <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${monitoring.failed > 0 && monitoring.failed >= monitoring.sent ? "bg-destructive" : "bg-emerald-500"}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs pt-1">
        <div>
          <span className="text-muted-foreground">Queued</span>
          <p className="font-mono font-medium" data-testid={`text-monitoring-queued-${campaignId}`}>{formatNumber(monitoring.pending)}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Delivered</span>
          <p className="font-mono font-medium">{formatNumber(monitoring.delivered)}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Failed</span>
          <p className={`font-mono font-medium ${monitoring.failed > 0 ? "text-destructive" : ""}`} data-testid={`text-monitoring-failed-${campaignId}`}>
            {formatNumber(monitoring.failed)}
          </p>
        </div>
        <div>
          <span className="text-muted-foreground">Configured speed</span>
          <p className="font-mono font-medium">{monitoring.effectiveConfiguredTps}/s</p>
        </div>
      </div>
      {(monitoring.staleLeases > 0 || monitoring.throttledRoutes > 0 || topErrors.length > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {monitoring.throttledRoutes > 0 && (
            <Badge variant="warning" className="text-[10px] py-0 h-5">{monitoring.throttledRoutes} sender(s) rate-limited</Badge>
          )}
          {monitoring.staleLeases > 0 && (
            <Badge variant="warning" className="text-[10px] py-0 h-5">{monitoring.staleLeases} send(s) recovering</Badge>
          )}
          {topErrors.map(([reason, count]) => (
            <Badge key={reason} variant="destructive" className="text-[10px] py-0 h-5" title={reason}>
              {reason}: {count}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
