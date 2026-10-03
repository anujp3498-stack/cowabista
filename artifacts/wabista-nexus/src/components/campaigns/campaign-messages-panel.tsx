import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Loader2, Search } from "lucide-react"
import {
  getExportCampaignMessagesUrl,
  useSearchCampaignMessages,
  type CampaignMessageRecord,
  type CampaignMessageRecordJobStatus,
} from "@workspace/api-client-react"
import { StatusChip } from "@/components/app/status-chip"
import { EmptyState } from "@/components/app/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

const MESSAGES_PAGE_SIZE = 15

const STATUS_FILTERS: { value: CampaignMessageRecordJobStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "Queued", label: "Waiting" },
  { value: "Processing", label: "Sending" },
  { value: "Throttled", label: "Rate-limited" },
  { value: "Sent", label: "Sent" },
  { value: "Failed", label: "Failed" },
  { value: "Cancelled", label: "Cancelled" },
]

// Per-recipient delivery observability: exactly what happened to each queued
// send -- job status, retry attempts, the job-level error and, once the
// provider accepted it, the provider's own delivery status/error. Reads the
// same campaign_jobs + provider_messages rows the runtime writes, so it can
// never show a status the runtime didn't record. Used by the campaign
// detail Messages tab and by the legacy dialog.
export function CampaignMessagesPanel({
  organizationId,
  campaignId,
  active = true,
  compact = false,
}: {
  organizationId: number | undefined
  campaignId: number | undefined
  /** When false (dialog closed) no requests are made. */
  active?: boolean
  compact?: boolean
}) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<CampaignMessageRecordJobStatus | "all">("all")
  const [offset, setOffset] = useState(0)
  const messagesMutation = useSearchCampaignMessages()
  const [page, setPage] = useState<{
    total: number
    limit: number
    offset: number
    messages: CampaignMessageRecord[]
  } | null>(null)

  const runSearch = (searchValue: string, status: CampaignMessageRecordJobStatus | "all", offsetValue: number) => {
    if (!organizationId || !campaignId) return
    messagesMutation.mutate(
      {
        organizationId,
        campaignId,
        data: {
          search: searchValue.trim() || undefined,
          status: status === "all" ? undefined : status,
          limit: MESSAGES_PAGE_SIZE,
          offset: offsetValue,
        },
      },
      { onSuccess: (res) => setPage(res) },
    )
  }

  useEffect(() => {
    if (!active || !campaignId) return
    const handle = setTimeout(() => runSearch(search, statusFilter, offset), search ? 300 : 0)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, campaignId, search, statusFilter, offset])

  useEffect(() => {
    if (!active) {
      setSearch("")
      setStatusFilter("all")
      setOffset(0)
      setPage(null)
    }
  }, [active])

  const isFiltered = Boolean(search.trim()) || statusFilter !== "all"

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <Input
            className="pl-8"
            placeholder="Search by phone number or error reason..."
            aria-label="Search messages"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setOffset(0)
            }}
            data-testid="input-messages-search"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value as CampaignMessageRecordJobStatus | "all")
            setOffset(0)
          }}
        >
          <SelectTrigger className="sm:w-[160px]" data-testid="select-messages-status" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {organizationId && campaignId && (
          <Button asChild variant="outline" className="gap-2 shrink-0" data-testid="button-export-delivery-log">
            <a href={getExportCampaignMessagesUrl(organizationId, campaignId)} download>
              <Download className="h-3.5 w-3.5" />
              Export delivery log
            </a>
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        The export contains the full delivery log (status, attempts, errors, timestamps) for every recipient. It does not include the original CSV columns yet.
      </p>

      <div className={cn("space-y-2", compact && "max-h-[55vh] overflow-y-auto pr-1")} data-testid="list-campaign-messages">
        {messagesMutation.isPending && !page && (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        )}
        {page?.messages.length === 0 && (
          <EmptyState
            title={isFiltered ? "No messages match this search." : "No messages yet."}
            description={isFiltered ? "Try a different phone number, error text or status." : "Messages appear here once the campaign starts sending."}
            data-testid="text-no-messages"
          />
        )}
        {page?.messages.map((message) => (
          <div key={message.jobId} className="rounded-md border p-3 text-sm space-y-1" data-testid={`row-campaign-message-${message.jobId}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs">{message.phone ?? `contact #${message.contactId}`}</span>
              <StatusChip kind="message" value={message.jobStatus} data-testid={`badge-message-status-${message.jobId}`} />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{message.templateName ?? `template #${message.templateId}`}</span>
              <span>attempt {message.attempts}/{message.maxAttempts}</span>
            </div>
            {(message.jobErrorReason || message.providerErrorReason) && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-destructive text-xs">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div className="flex-1 space-y-0.5">
                  <span className="block">{message.providerErrorReason ?? message.jobErrorReason}</span>
                  {(message.lastStatusAt ?? message.acceptedAt) && (
                    <span className="block text-[10px] text-destructive/70" data-testid={`text-message-failed-at-${message.jobId}`}>
                      Failed at {new Date(message.lastStatusAt ?? message.acceptedAt!).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
            )}
            {message.providerStatus && !message.jobErrorReason && !message.providerErrorReason && (
              <p className="text-xs text-muted-foreground">Provider status: {message.providerStatus}</p>
            )}
          </div>
        ))}
      </div>

      {page && page.total > page.limit && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            {page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {page.total}
          </span>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              aria-label="Previous page"
              disabled={offset === 0 || messagesMutation.isPending}
              onClick={() => setOffset(Math.max(0, offset - MESSAGES_PAGE_SIZE))}
              data-testid="button-messages-prev-page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              aria-label="Next page"
              disabled={offset + page.limit >= page.total || messagesMutation.isPending}
              onClick={() => setOffset(offset + MESSAGES_PAGE_SIZE)}
              data-testid="button-messages-next-page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
      {messagesMutation.isPending && page && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Refreshing…
        </div>
      )}
    </div>
  )
}
