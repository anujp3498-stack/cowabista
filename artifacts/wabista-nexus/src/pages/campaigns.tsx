import { useEffect, useState } from "react"
import { Link, useLocation, useSearch } from "wouter"
import { Loader2, MoreHorizontal, PauseCircle, PlayCircle, Plus, Rocket, Search, Send, Trash2, XCircle } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useDeleteCampaign, useListCampaignsPage, type Campaign, type ListCampaignsPageStatus } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { EmptyState, ErrorState, PageHeader, StatusChip, TableRowsSkeleton } from "@/components/app"
import { Skeleton } from "@/components/ui/skeleton"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { useCampaignLifecycle } from "@/hooks/use-campaign-lifecycle"
import { useToast } from "@/hooks/use-toast"
import { invalidateCampaignQueries } from "@/lib/campaign-queries"
import { messageFrom } from "@/lib/api-errors"
import { statusLabel } from "@/lib/status"
import { formatNumber } from "@/lib/utils"
import { canCancelCampaign, canPauseCampaign, canResumeCampaign } from "@/lib/campaign-status"
import { CampaignNotReadyDialog } from "@/components/campaigns/campaign-not-ready-dialog"

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300
const STATUSES: ListCampaignsPageStatus[] = ["Draft", "Ready", "Scheduled", "Running", "Paused", "Completed", "Cancelled", "Failed"]

// Server-paginated campaign list (keyset by id, newest first) with server
// search and status filter. Pages accumulate client-side as the person
// loads more; a search/filter change resets to the first page.
export default function Campaigns() {
  const [, navigate] = useLocation()
  const initialStatus = new URLSearchParams(useSearch()).get("status")
  const { organization } = useActiveOrganization()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const deleteCampaign = useDeleteCampaign()
  const { handleAction, isPending: isActioning, isActioningAs, notReady, setNotReady } = useCampaignLifecycle(organization?.id)

  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<ListCampaignsPageStatus | "all">(
    STATUSES.includes(initialStatus as ListCampaignsPageStatus) ? (initialStatus as ListCampaignsPageStatus) : "all",
  )
  const [cursor, setCursor] = useState<number | undefined>(undefined)
  const [loaded, setLoaded] = useState<Campaign[]>([])
  const [cancelling, setCancelling] = useState<Campaign | null>(null)
  const [deleting, setDeleting] = useState<Campaign | null>(null)

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [searchInput])

  // Any change to the filters restarts at the first page.
  useEffect(() => {
    setCursor(undefined)
    setLoaded([])
  }, [search, status])

  const params = {
    limit: PAGE_SIZE,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(search ? { search } : {}),
    ...(status !== "all" ? { status } : {}),
  }
  const page = useListCampaignsPage(params)

  // Merge the current page into the accumulated list, de-duplicating by id
  // (a refetch of an earlier page after a mutation must not add duplicates).
  const pageItems = page.data?.items
  useEffect(() => {
    if (!pageItems) return
    setLoaded((previous) => {
      const base = cursor === undefined ? [] : previous
      const seen = new Set(base.map((c) => c.id))
      return [...base, ...pageItems.filter((c) => !seen.has(c.id))]
    })
  }, [pageItems, cursor])

  // When a mutation invalidates the paged query, the first page refetches;
  // reflect updated rows (status/name) without dropping later pages.
  const items = cursor === undefined ? (pageItems ?? loaded) : loaded.map((c) => pageItems?.find((p) => p.id === c.id) ?? c)
  const isFiltered = Boolean(search) || status !== "all"
  const isFirstLoad = page.isLoading && cursor === undefined

  const confirmDelete = () => {
    if (!deleting) return
    deleteCampaign.mutate(
      { campaignId: deleting.id },
      {
        onSuccess: () => {
          void invalidateCampaignQueries(queryClient, organization?.id, deleting.id)
          setLoaded((previous) => previous.filter((c) => c.id !== deleting.id))
          toast({ title: "Campaign deleted" })
          setDeleting(null)
        },
        onError: (error) => toast({ title: messageFrom(error, "Failed to delete campaign"), variant: "destructive" }),
      },
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        description="Manage and monitor your WhatsApp campaigns."
        primaryAction={
          <Button className="gap-2" data-testid="button-new-campaign" onClick={() => navigate("/campaigns/new")}>
            <Plus className="h-4 w-4" />
            New campaign
          </Button>
        }
        secondaryActions={
          <Button asChild variant="outline" className="gap-2">
            <Link href="/rocket-campaigns" data-testid="link-rocket-setup">
              <Rocket className="h-4 w-4" />
              Sending setup
            </Link>
          </Button>
        }
      />

      <Card>
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              placeholder="Search campaigns..."
              aria-label="Search campaigns"
              className="pl-9"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              data-testid="input-search-campaigns"
            />
          </div>
          <Select value={status} onValueChange={(value) => setStatus(value as ListCampaignsPageStatus | "all")}>
            <SelectTrigger className="sm:w-[180px]" aria-label="Filter by status" data-testid="select-campaign-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {statusLabel("campaign", value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {page.isError && cursor === undefined ? (
          <div className="p-4">
            <ErrorState title="Couldn't load campaigns." error={page.error} onRetry={() => void page.refetch()} data-testid="error-campaigns" />
          </div>
        ) : !isFirstLoad && items.length === 0 ? (
          <EmptyState
            icon={Send}
            title={isFiltered ? "No campaigns match your search." : "No campaigns yet."}
            description={isFiltered ? "Try another name or status." : "Create a campaign, then add recipients, senders and templates."}
            primaryAction={
              isFiltered ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchInput("")
                    setStatus("all")
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => navigate("/campaigns/new")}>New campaign</Button>
              )
            }
            data-testid="empty-campaigns"
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Recipients</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Delivered</TableHead>
                    <TableHead className="text-right">Read</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-[1%]"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isFirstLoad ? (
                    <TableRowsSkeleton rows={6} columns={9} />
                  ) : (
                    items.map((campaign) => (
                      <TableRow
                        key={campaign.id}
                        className="cursor-pointer"
                        onClick={() => navigate(`/campaigns/${campaign.id}`)}
                        data-testid={`row-campaign-${campaign.id}`}
                      >
                        <TableCell className="font-medium">
                          <Link href={`/campaigns/${campaign.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()} data-testid={`link-campaign-${campaign.id}`}>
                            {campaign.name}
                          </Link>
                          {campaign.isSample && <span className="ml-2 text-xs text-muted-foreground">Sample</span>}
                        </TableCell>
                        <TableCell><StatusChip kind="campaign" value={campaign.status} /></TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(campaign.audienceSize)}</TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(campaign.sent)}</TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(campaign.delivered)}</TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(campaign.read)}</TableCell>
                        <TableCell className={`text-right font-mono ${campaign.failed > 0 ? "text-destructive" : ""}`}>{formatNumber(campaign.failed)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{new Date(campaign.updatedAt).toLocaleDateString()}</TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <RowActions
                            campaign={campaign}
                            isActioning={isActioning}
                            isActioningAs={isActioningAs}
                            onAction={(action) => handleAction(campaign, action)}
                            onCancel={() => setCancelling(campaign)}
                            onDelete={() => setDeleting(campaign)}
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <ul className="divide-y md:hidden">
              {isFirstLoad
                ? Array.from({ length: 4 }).map((_, index) => (
                    <li key={index} className="space-y-2 p-4" aria-busy="true">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-2 w-full" />
                    </li>
                  ))
                : items.map((campaign) => {
                    const progress = campaign.audienceSize > 0 ? Math.min(100, (campaign.sent / campaign.audienceSize) * 100) : 0
                    return (
                      <li key={campaign.id} className="flex items-start gap-3 p-4" data-testid={`card-campaign-${campaign.id}`}>
                        <Link href={`/campaigns/${campaign.id}`} className="min-w-0 flex-1 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium">{campaign.name}</span>
                            <StatusChip kind="campaign" value={campaign.status} />
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {formatNumber(campaign.sent)} / {formatNumber(campaign.audienceSize)} sent
                            {campaign.failed > 0 ? <span className="text-destructive"> · {formatNumber(campaign.failed)} failed</span> : null}
                          </div>
                        </Link>
                        <RowActions
                          campaign={campaign}
                          isActioning={isActioning}
                          isActioningAs={isActioningAs}
                          onAction={(action) => handleAction(campaign, action)}
                          onCancel={() => setCancelling(campaign)}
                          onDelete={() => setDeleting(campaign)}
                        />
                      </li>
                    )
                  })}
            </ul>

            {page.data?.hasMore && (
              <div className="border-t p-3 text-center">
                <Button
                  variant="outline"
                  disabled={page.isFetching}
                  onClick={() => setCursor(page.data?.nextCursor ?? undefined)}
                  data-testid="button-load-more-campaigns"
                >
                  {page.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      <CampaignNotReadyDialog notReady={notReady} onClose={() => setNotReady(null)} />

      <AlertDialog open={!!cancelling} onOpenChange={(open) => !open && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {cancelling?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the campaign for good: waiting sends are cancelled and it cannot be resumed. Use Pause if you want to continue later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep campaign</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (cancelling) handleAction(cancelling, "cancel")
                setCancelling(null)
              }}
              data-testid="button-confirm-cancel-campaign"
            >
              Stop campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes {deleting?.name}, its senders, imported recipients and delivery log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteCampaign.isPending}
              onClick={confirmDelete}
              data-testid="button-confirm-delete-campaign"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RowActions({
  campaign,
  isActioning,
  isActioningAs,
  onAction,
  onCancel,
  onDelete,
}: {
  campaign: Campaign
  isActioning: boolean
  isActioningAs: (campaignId: number, action: "pause" | "resume") => boolean
  onAction: (action: "pause" | "resume") => void
  onCancel: () => void
  onDelete: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${campaign.name}`} data-testid={`button-campaign-actions-${campaign.id}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/campaigns/${campaign.id}`} data-testid={`button-open-campaign-${campaign.id}`}>Open</Link>
        </DropdownMenuItem>
        {canPauseCampaign(campaign.status) && (
          <DropdownMenuItem disabled={isActioning} onClick={() => onAction("pause")} data-testid={`button-pause-campaign-${campaign.id}`}>
            {isActioningAs(campaign.id, "pause") ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PauseCircle className="mr-2 h-4 w-4" />}
            Pause
          </DropdownMenuItem>
        )}
        {canResumeCampaign(campaign.status) && (
          <DropdownMenuItem disabled={isActioning} onClick={() => onAction("resume")} data-testid={`button-resume-campaign-${campaign.id}`}>
            {isActioningAs(campaign.id, "resume") ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
            Resume
          </DropdownMenuItem>
        )}
        {canCancelCampaign(campaign.status) && (
          <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={isActioning} onClick={onCancel} data-testid={`button-cancel-campaign-${campaign.id}`}>
            <XCircle className="mr-2 h-4 w-4" /> Stop
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete} data-testid={`button-delete-campaign-${campaign.id}`}>
          <Trash2 className="mr-2 h-4 w-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
