import type { QueryClient } from "@tanstack/react-query"
import {
  getGetCampaignMonitoringQueryKey,
  getGetCampaignQueryKey,
  getGetCampaignReadinessQueryKey,
  getListCampaignsPageQueryKey,
  getListCampaignsQueryKey,
} from "@workspace/api-client-react"

// Every write that changes a campaign (create, edit, delete, lifecycle
// transition, import, mapping) must invalidate both the legacy bare-array
// list (still used by the Rocket page and dialogs) and the V2 paged list,
// plus the single-campaign read and live panels when a campaign id is known.
// Orval-generated mutations never invalidate anything on their own.
export function invalidateCampaignQueries(queryClient: QueryClient, organizationId?: number, campaignId?: number) {
  const invalidations = [
    queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() }),
    // The paged key is [`/api/campaigns/list`, params]; invalidate every params variant.
    queryClient.invalidateQueries({ queryKey: getListCampaignsPageQueryKey() }),
  ]
  if (campaignId !== undefined) {
    invalidations.push(queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(campaignId) }))
    if (organizationId !== undefined) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: getGetCampaignMonitoringQueryKey(organizationId, campaignId) }),
        queryClient.invalidateQueries({ queryKey: getGetCampaignReadinessQueryKey(organizationId, campaignId) }),
      )
    }
  }
  return Promise.all(invalidations)
}
