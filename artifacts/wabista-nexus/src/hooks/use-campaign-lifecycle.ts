import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useTransitionCampaign,
  getListCampaignsQueryKey,
  getGetCampaignMonitoringQueryKey,
  type Campaign,
  type CampaignActionInputAction,
} from "@workspace/api-client-react"
import { useToast } from "@/hooks/use-toast"
import { errorDetailsFrom, messageFrom } from "@/lib/api-errors"

export type NotReadyState = { name: string; action: CampaignActionInputAction; errors: string[] }

// Shared Plan/Execute action handling for any screen that lets a manager
// transition a campaign (Campaigns page, Rocket Engine screen). The backend
// contract (POST .../campaigns/:id/actions) is campaignId/organizationId
// scoped, not page-scoped, so every caller can safely share one mutation +
// one "not ready" readiness-error dialog instead of re-implementing it.
export function useCampaignLifecycle(organizationId: number | undefined) {
  const transitionCampaign = useTransitionCampaign()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [actioningId, setActioningId] = useState<number | null>(null)
  const [notReady, setNotReady] = useState<NotReadyState | null>(null)

  const invalidateCampaigns = () =>
    queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() })

  const handleAction = (campaign: Campaign, action: CampaignActionInputAction) => {
    if (!organizationId) return
    setActioningId(campaign.id)
    transitionCampaign.mutate(
      { organizationId, campaignId: campaign.id, data: { action } },
      {
        onSuccess: () => {
          invalidateCampaigns()
          // Plan/execute freshly changes queue/sent/failed counts, so the
          // Rocket Engine's live monitoring panel must refetch immediately
          // rather than waiting out its poll interval.
          queryClient.invalidateQueries({
            queryKey: getGetCampaignMonitoringQueryKey(organizationId, campaign.id),
          })
          toast({
            title: action === "plan"
              ? "Campaign planned — allocation snapshot frozen"
              : "Campaign execution started",
          })
        },
        onError: (error) => {
          const errors = errorDetailsFrom(error)
          if (errors && errors.length) {
            setNotReady({ name: campaign.name, action, errors })
          } else {
            toast({
              title: messageFrom(error, `Failed to ${action} campaign`),
              variant: "destructive",
            })
          }
        },
        onSettled: () => setActioningId(null),
      },
    )
  }

  const isActioningAs = (campaignId: number, action: CampaignActionInputAction) =>
    transitionCampaign.isPending && actioningId === campaignId && transitionCampaign.variables?.data.action === action

  return {
    handleAction,
    actioningId,
    isPending: transitionCampaign.isPending,
    isActioningAs,
    notReady,
    setNotReady,
  }
}
