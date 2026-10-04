import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FileText, RefreshCw, Search } from "lucide-react"
import {
  getListTemplatesQueryKey,
  useListTemplates,
  useSyncWhatsAppTemplates,
  type Template,
  type WhatsAppTemplateSyncResult,
} from "@workspace/api-client-react"
import { EmptyState, ErrorState, PageHeader, StatusChip, TableRowsSkeleton } from "@/components/app"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TemplateDraftsTab } from "@/components/templates/template-drafts-tab"
import { TemplatePreviewDialog, headerKind } from "@/components/templates/template-preview-dialog"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { useToast } from "@/hooks/use-toast"
import { messageFrom } from "@/lib/api-errors"

// Template Center (V2-03A). Everything shown comes from Meta through a
// synchronisation the server runs with the workspace's own stored
// credentials (or the legacy connector): nothing here can be typed in by
// hand, and status, language and category are read-only. Sample rows are
// never listed as real templates. Authoring (V2-03B) lives on the Drafts
// tab: a draft is a Wabista record until it is explicitly submitted to Meta,
// and even then its approval status is only ever what Meta reports.

const ALL = "__all__"
type Tab = "meta" | "drafts"

/** Honest sync summary: superseded WABAs are not counted as synced. */
export function describeSyncResult(result: WhatsAppTemplateSyncResult): { title: string; description?: string; variant?: "destructive" } {
  const failed = result.wabas.filter((item) => item.status === "failed")
  const synced = result.wabas.filter((item) => item.status === "synced")
  const superseded = result.wabas.filter((item) => item.status === "superseded")
  if (!result.wabas.length) return { title: "Nothing to sync yet", description: "Connect a WhatsApp number first." }
  if (failed.length) return { title: "Some business accounts could not be synced", description: failed.map((item) => item.wabaDisplayName).join(", "), variant: "destructive" }
  if (!synced.length && superseded.length) {
    return { title: "Already up to date", description: `A newer sync of ${superseded.map((item) => item.wabaDisplayName).join(", ")} finished first; its result is what you see.` }
  }
  const seen = synced.reduce((sum, item) => sum + item.templatesSeen, 0)
  const note = superseded.length ? ` ${superseded.length === 1 ? "One account was" : `${superseded.length} accounts were`} already refreshed by a newer sync.` : ""
  return { title: "Templates synced", description: `${seen} ${seen === 1 ? "template" : "templates"} from ${synced.length} business ${synced.length === 1 ? "account" : "accounts"}.${note}` }
}

export default function Templates() {
  const { organizationId, role } = useActiveOrganization()
  const canSync = role === "owner" || role === "admin"
  const canAuthor = canSync
  const [tab, setTab] = useState<Tab>("meta")
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const templates = useListTemplates()
  const sync = useSyncWhatsAppTemplates()

  const [search, setSearch] = useState("")
  const [status, setStatus] = useState(ALL)
  const [language, setLanguage] = useState(ALL)
  const [category, setCategory] = useState(ALL)
  const [waba, setWaba] = useState(ALL)
  const [preview, setPreview] = useState<Template | null>(null)
  const [lastSync, setLastSync] = useState<WhatsAppTemplateSyncResult | null>(null)

  const real = useMemo(() => (templates.data ?? []).filter((row) => !row.isSample), [templates.data])
  const sampleCount = (templates.data?.length ?? 0) - real.length
  const options = useMemo(() => {
    const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))].sort()
    return {
      statuses: unique(real.map((row) => row.status)),
      languages: unique(real.map((row) => row.language)),
      categories: unique(real.map((row) => row.category)),
      wabas: unique(real.map((row) => row.wabaDisplayName ?? row.wabaExternalId)),
    }
  }, [real])
  const rows = useMemo(
    () =>
      real.filter(
        (row) =>
          (!search || row.name.toLowerCase().includes(search.toLowerCase())) &&
          (status === ALL || row.status === status) &&
          (language === ALL || row.language === language) &&
          (category === ALL || row.category === category) &&
          (waba === ALL || (row.wabaDisplayName ?? row.wabaExternalId) === waba),
      ),
    [real, search, status, language, category, waba],
  )
  const approvedCount = real.filter((row) => row.status === "Approved").length

  const runSync = () => {
    if (!organizationId || sync.isPending) return
    sync.mutate(
      { organizationId },
      {
        onSuccess: (result) => {
          setLastSync(result)
          void queryClient.invalidateQueries({ queryKey: getListTemplatesQueryKey() })
          toast(describeSyncResult(result))
        },
        onError: (error) => toast({ title: messageFrom(error, "Couldn't sync templates."), variant: "destructive" }),
      },
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description="Message templates available for WhatsApp campaigns."
        primaryAction={
          <Button
            className="gap-2"
            onClick={runSync}
            disabled={!canSync || sync.isPending}
            title={canSync ? undefined : "Only workspace owners and admins can sync templates."}
            data-testid="button-sync-templates"
          >
            <RefreshCw className={`h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} />
            {sync.isPending ? "Syncing…" : "Sync templates"}
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList className="w-max">
          <TabsTrigger value="meta" data-testid="tab-templates-meta">Meta templates</TabsTrigger>
          <TabsTrigger value="drafts" data-testid="tab-templates-drafts">Drafts</TabsTrigger>
        </TabsList>
        <TabsContent value="drafts" className="mt-4">
          {organizationId ? <TemplateDraftsTab organizationId={organizationId} canAuthor={canAuthor} /> : null}
        </TabsContent>
        <TabsContent value="meta" className="mt-4 space-y-6">

      {lastSync?.wabas.some((item) => item.status === "failed") ? (
        <Alert variant="destructive" data-testid="alert-sync-failures">
          <AlertTitle>Some business accounts could not be synced</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc pl-4">
              {lastSync.wabas.filter((item) => item.status === "failed").map((item) => (
                <li key={item.wabaId}>
                  <span className="font-medium">{item.wabaDisplayName}</span>: {item.error?.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle className="text-base">Meta templates</CardTitle>
            <CardDescription>
              {templates.isSuccess
                ? real.length === 0
                  ? "No templates synced yet."
                  : `${real.length} ${real.length === 1 ? "template" : "templates"}, ${approvedCount} approved and ready to send.${sampleCount ? ` ${sampleCount} sample ${sampleCount === 1 ? "record is" : "records are"} hidden.` : ""}`
                : "Loading…"}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input placeholder="Search by name" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-search-templates" />
            </div>
            <FilterSelect label="Status" value={status} onChange={setStatus} values={options.statuses} testId="select-filter-status" />
            <FilterSelect label="Language" value={language} onChange={setLanguage} values={options.languages} testId="select-filter-language" />
            <FilterSelect label="Category" value={category} onChange={setCategory} values={options.categories} testId="select-filter-category" />
            <FilterSelect label="Business account" value={waba} onChange={setWaba} values={options.wabas} testId="select-filter-waba" />
          </div>
        </CardHeader>
        <CardContent>
          {templates.isLoading ? (
            <Table>
              <TableBody>
                <TableRowsSkeleton rows={4} columns={6} />
              </TableBody>
            </Table>
          ) : templates.isError ? (
            <ErrorState title="Couldn't load templates." error={templates.error} onRetry={() => void templates.refetch()} data-testid="error-templates" />
          ) : real.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No templates synced yet."
              description={canSync ? "Sync to pull the message templates approved for your WhatsApp numbers." : "Ask a workspace owner or admin to sync templates."}
              primaryAction={
                canSync ? (
                  <Button onClick={runSync} disabled={sync.isPending} data-testid="button-sync-templates-empty">
                    Sync templates
                  </Button>
                ) : undefined
              }
              data-testid="empty-templates"
            />
          ) : rows.length === 0 ? (
            <EmptyState title="No templates match these filters." size="inline" data-testid="empty-templates-filtered" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Language</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead className="hidden lg:table-cell">Business account</TableHead>
                  <TableHead className="hidden lg:table-cell">Last synced</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const header = headerKind(row)
                  return (
                    <TableRow key={row.id} className="cursor-pointer" onClick={() => setPreview(row)} data-testid={`row-template-${row.id}`}>
                      <TableCell>
                        <div className="font-mono text-sm">{row.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {header && header !== "TEXT" ? `${header.toLowerCase()} header · ` : ""}
                          {row.body.length > 72 ? `${row.body.slice(0, 72)}…` : row.body}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusChip kind="template" value={row.status} data-testid={`chip-template-status-${row.id}`} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">{row.language}</TableCell>
                      <TableCell className="hidden md:table-cell text-sm">{row.category}</TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">{row.wabaDisplayName ?? row.wabaExternalId ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString() : "Never"}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

        </TabsContent>
      </Tabs>

      <TemplatePreviewDialog template={preview} onOpenChange={(open) => { if (!open) setPreview(null) }} />
    </div>
  )
}

function FilterSelect({ label, value, onChange, values, testId }: { label: string; value: string; onChange: (value: string) => void; values: string[]; testId: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-44" aria-label={label} data-testid={testId}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}</SelectItem>
        {values.map((item) => (
          <SelectItem key={item} value={item}>{item}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
