import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Loader2, Search } from "lucide-react"
import {
  getExportCampaignMessagesUrl,
  useSearchCampaignMessages,
  type Campaign,
  type CampaignMessageRecord,
  type CampaignMessageRecordJobStatus,
} from "@workspace/api-client-react"

const MESSAGES_PAGE_SIZE = 15

const STATUS_FILTERS: { value: CampaignMessageRecordJobStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "Queued", label: "Queued" },
  { value: "Processing", label: "Processing" },
  { value: "Throttled", label: "Throttled" },
  { value: "Sent", label: "Sent" },
  { value: "Failed", label: "Failed" },
  { value: "Cancelled", label: "Cancelled" },
]

function statusVariant(status: CampaignMessageRecordJobStatus): "default" | "secondary" | "destructive" | "success" | "warning" | "outline" {
  switch (status) {
    case "Sent":
      return "success"
    case "Failed":
      return "destructive"
    case "Throttled":
      return "warning"
    case "Cancelled":
      return "outline"
    default:
      return "secondary"
  }
}

// Per-recipient delivery observability for support/ops: exactly what
// happened to each queued send -- current job status, retry attempts, the
// job-level error (e.g. exhausted retries) and, once the provider accepted
// it, the provider's own delivery status/error. Reads the same campaign_jobs
// + provider_messages rows the runtime itself writes (campaign-queue.ts,
// whatsapp-template-sender.ts), so this can never show a status the runtime
// didn't actually record.
export function CampaignMessagesDialog({
  campaign,
  organizationId,
  open,
  onOpenChange,
}: {
  campaign: Campaign | null
  organizationId: number | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const campaignId = campaign?.id
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
    if (!open || !campaignId) return
    const handle = setTimeout(() => runSearch(search, statusFilter, offset), search ? 300 : 0)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, campaignId, search, statusFilter, offset])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSearch("")
          setStatusFilter("all")
          setOffset(0)
          setPage(null)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-2xl sm:max-w-3xl" data-testid="dialog-campaign-messages">
        <DialogHeader>
          <DialogTitle>Delivery log — {campaign?.name}</DialogTitle>
          <DialogDescription>
            Per-recipient send status, retry attempts, and provider errors, straight from the send queue.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search by phone number or error reason..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setOffset(0)
              }}
              data-testid="input-messages-search"
            />
          </div>
          {organizationId && campaignId && (
            <Button asChild variant="outline" size="sm" className="gap-2 shrink-0" data-testid="button-export-delivery-log">
              <a href={getExportCampaignMessagesUrl(organizationId, campaignId)} download>
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </a>
            </Button>
          )}
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value as CampaignMessageRecordJobStatus | "all")
              setOffset(0)
            }}
          >
            <SelectTrigger className="w-[160px]" data-testid="select-messages-status">
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
        </div>

        <ScrollArea className="max-h-[55vh] pr-3">
          <div className="space-y-2" data-testid="list-campaign-messages">
            {messagesMutation.isPending && !page && (
              <div className="flex items-center justify-center py-10 text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading messages...
              </div>
            )}
            {page?.messages.length === 0 && (
              <p className="text-xs text-muted-foreground py-2" data-testid="text-no-messages">
                No messages match this search yet.
              </p>
            )}
            {page?.messages.map((message) => (
              <div
                key={message.jobId}
                className="rounded-md border p-3 text-sm space-y-1"
                data-testid={`row-campaign-message-${message.jobId}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{message.phone ?? `contact #${message.contactId}`}</span>
                  <Badge variant={statusVariant(message.jobStatus) as any} data-testid={`badge-message-status-${message.jobId}`}>
                    {message.jobStatus}
                  </Badge>
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
        </ScrollArea>

        {page && page.total > page.limit && (
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-muted-foreground">
              {page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {page.total}
            </span>
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7"
                disabled={offset === 0 || messagesMutation.isPending}
                onClick={() => setOffset(Math.max(0, offset - MESSAGES_PAGE_SIZE))}
                data-testid="button-messages-prev-page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7"
                disabled={offset + page.limit >= page.total || messagesMutation.isPending}
                onClick={() => setOffset(offset + MESSAGES_PAGE_SIZE)}
                data-testid="button-messages-next-page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-close-campaign-messages">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
