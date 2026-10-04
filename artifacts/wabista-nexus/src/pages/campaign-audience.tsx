import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useParams } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  Lock,
  RotateCcw,
} from "lucide-react"
import {
  createCampaign,
  getGetCampaignAudienceQueryKey,
  getGetCampaignQueryKey,
  updateCampaign,
  useGetCampaign,
  useGetCampaignAudience,
  useTransitionCampaign,
  type Campaign,
  type CampaignAudience,
  type ContactImportSession,
  type CsvSniffResult,
} from "@workspace/api-client-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState, ErrorState, PageHeaderSkeleton, StatStripSkeleton, StatusChip } from "@/components/app"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { useToast } from "@/hooks/use-toast"
import { invalidateCampaignQueries } from "@/lib/campaign-queries"
import { messageFrom } from "@/lib/api-errors"
import { formatNumber } from "@/lib/utils"
import {
  clearNewCampaignCreationKey,
  codeOf,
  createSaveSequencer,
  duplicateRowsUrl,
  newCampaignCreationKey,
  rejectedRowsUrl,
  sessionDataRows,
  sniffCsv,
  uploadAudienceCsv,
  uploadKeyFor,
  type UploadConfig,
} from "@/lib/audience-model"

// Rocket Audience step (V2-05A). `/campaigns/new` creates ONE Draft (a
// creation key makes retries and double effects replay the same campaign)
// and replaces the URL with `/campaigns/:id/audience`, the stable resume
// URL. Nothing on this page plans, executes or sends: it ends with a saved
// audience and a link to the existing campaign setup.

export function NewCampaignPage() {
  const [, navigate] = useLocation()
  const { organization } = useActiveOrganization()
  const [error, setError] = useState<unknown>(null)
  const startedRef = useRef(false)

  const start = useCallback(async () => {
    setError(null)
    try {
      const created = await createCampaign({ name: "Untitled campaign", creationKey: newCampaignCreationKey() })
      clearNewCampaignCreationKey()
      navigate(`/campaigns/${created.id}/audience`, { replace: true })
    } catch (failure) {
      setError(failure)
    }
  }, [navigate])

  useEffect(() => {
    if (!organization || startedRef.current) return
    startedRef.current = true
    void start()
  }, [organization, start])

  if (error) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorState
          title="Couldn't start a new campaign."
          description="Nothing was created twice: retrying uses the same draft."
          error={error}
          onRetry={() => void start()}
        />
      </div>
    )
  }
  return (
    <div className="space-y-6" aria-busy="true">
      <BackLink />
      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="state-creating-draft">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Creating a draft campaign...
      </div>
    </div>
  )
}

export default function CampaignAudiencePage() {
  const params = useParams<{ campaignId: string }>()
  const campaignId = Number(params.campaignId)
  const { organization } = useActiveOrganization()
  const campaignQuery = useGetCampaign(campaignId)

  if (!Number.isInteger(campaignId) || campaignId < 1) return <NotFound />
  if (campaignQuery.isLoading || !organization) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatStripSkeleton />
      </div>
    )
  }
  if (campaignQuery.isError || !campaignQuery.data) {
    const status = (campaignQuery.error as { status?: number } | null)?.status
    if (status === 404) return <NotFound />
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorState title="Couldn't load this campaign." error={campaignQuery.error} onRetry={() => void campaignQuery.refetch()} />
      </div>
    )
  }
  return <AudienceWorkspace campaign={campaignQuery.data} organizationId={organization.id} />
}

export function AudienceWorkspace({ campaign, organizationId }: { campaign: Campaign; organizationId: number }) {
  const audienceQuery = useGetCampaignAudience(organizationId, campaign.id, {
    query: {
      refetchInterval: (query: { state: { data?: CampaignAudience } }) => (query.state.data?.importInProgress ? 1500 : false),
    } as never,
  })
  const audience = audienceQuery.data

  return (
    <div className="space-y-6">
      <BackLink />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs text-muted-foreground">New campaign · Step 1 of 2: Audience</p>
          <CampaignNameField campaign={campaign} />
        </div>
        <div className="self-start">
          <StatusChip kind="campaign" value={campaign.status} data-testid="chip-audience-campaign-status" />
        </div>
      </header>

      {audienceQuery.isLoading ? (
        <StatStripSkeleton />
      ) : audienceQuery.isError || !audience ? (
        <ErrorState title="Couldn't load the audience." error={audienceQuery.error} onRetry={() => void audienceQuery.refetch()} />
      ) : (
        <>
          <AudienceSummary audience={audience} />
          <LifecycleBanner audience={audience} campaign={campaign} organizationId={organizationId} />
          <UploadCard audience={audience} campaign={campaign} organizationId={organizationId} />
          <SessionsCard audience={audience} organizationId={organizationId} campaignId={campaign.id} />
        </>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Your audience is saved as you go. Senders, templates and variables are chosen in the campaign setup; nothing is sent from this page.
          </p>
          <Button asChild className="gap-2" data-testid="link-continue-to-setup">
            <Link href={`/campaigns/${campaign.id}?tab=setup`}>
              Continue to setup <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Autosaved name                                                      */
/* ------------------------------------------------------------------ */

function CampaignNameField({ campaign }: { campaign: Campaign }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(campaign.name)
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const revisionRef = useRef(campaign.revision)
  const sequencer = useRef(createSaveSequencer()).current
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)

  // Adopt server changes only while the user has nothing unsaved.
  useEffect(() => {
    if (!dirty.current) {
      setName(campaign.name)
      revisionRef.current = campaign.revision
    }
  }, [campaign.name, campaign.revision])

  const save = useCallback(async (value: string, attempt = 0): Promise<void> => {
    const ticket = sequencer.next()
    setState("saving")
    try {
      const updated = await updateCampaign(campaign.id, { name: value, revision: revisionRef.current })
      if (!sequencer.isLatest(ticket)) return
      revisionRef.current = updated.revision
      dirty.current = false
      setState("saved")
      queryClient.setQueryData(getGetCampaignQueryKey(campaign.id), updated)
    } catch (error) {
      if (!sequencer.isLatest(ticket)) return
      const current = (error as { data?: { campaign?: Campaign } }).data?.campaign
      if (codeOf(error) === "stale_revision" && current && attempt < 2) {
        // Someone (or an older tab) saved in between: rebase this newer edit
        // on the current revision and save it again.
        revisionRef.current = current.revision
        await save(value, attempt + 1)
        return
      }
      setState("error")
    }
  }, [campaign.id, queryClient, sequencer])

  const onChange = (value: string) => {
    setName(value)
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    if (!value.trim()) return
    timer.current = setTimeout(() => void save(value.trim()), 600)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <div className="space-y-1">
      <Label htmlFor="campaign-name" className="sr-only">Campaign name</Label>
      <Input
        id="campaign-name"
        value={name}
        onChange={(event) => onChange(event.target.value)}
        className="h-auto border-transparent px-0 text-2xl font-semibold shadow-none focus-visible:border-input focus-visible:px-2"
        aria-describedby="campaign-name-status"
        data-testid="input-campaign-name"
      />
      <p id="campaign-name-status" className="text-xs text-muted-foreground" aria-live="polite" data-testid="text-name-save-state">
        {!name.trim() ? "A campaign needs a name." : state === "saving" ? "Saving..." : state === "saved" ? "Saved" : state === "error" ? "Couldn't save the name. Keep typing to retry." : "Changes save automatically."}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Summary + lifecycle                                                 */
/* ------------------------------------------------------------------ */

function AudienceSummary({ audience }: { audience: CampaignAudience }) {
  const stats = [
    { label: "Ready to send", value: audience.totals.valid, testId: "stat-audience-valid" },
    { label: "Invalid", value: audience.totals.invalid, testId: "stat-audience-invalid" },
    { label: "Opted out", value: audience.totals.suppressed, testId: "stat-audience-suppressed" },
    { label: "Duplicates", value: audience.totals.duplicates, testId: "stat-audience-duplicates" },
  ]
  return (
    <section aria-label="Audience summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label}>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">{stat.label}</div>
            <div className="text-2xl font-semibold tabular-nums" data-testid={stat.testId}>{formatNumber(stat.value)}</div>
          </CardContent>
        </Card>
      ))}
      <p className="col-span-2 text-xs text-muted-foreground md:col-span-4">
        {audience.totals.sessions === 0
          ? "No recipients yet."
          : `${formatNumber(audience.totals.rows)} rows from ${audience.totals.sessions} upload${audience.totals.sessions === 1 ? "" : "s"}. Each number is sent at most once; repeats are kept only for your records.`}
      </p>
    </section>
  )
}

function LifecycleBanner({ audience, campaign, organizationId }: { audience: CampaignAudience; campaign: Campaign; organizationId: number }) {
  const transition = useTransitionCampaign()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  if (audience.executionHistory) {
    return (
      <Alert data-testid="banner-audience-frozen">
        <Lock className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>This audience is locked.</AlertTitle>
        <AlertDescription>Messages have already been queued or sent for this campaign, so its recipients can no longer change.</AlertDescription>
      </Alert>
    )
  }
  if (audience.reopenRequired) {
    return (
      <Alert data-testid="banner-audience-reopen">
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>This campaign is planned.</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>To change the audience, move it back to draft. Its frozen plan is discarded and you plan again in setup.</p>
          <Button
            variant="outline"
            size="sm"
            disabled={transition.isPending}
            data-testid="button-reopen-campaign"
            onClick={() => transition.mutate(
              { organizationId, campaignId: campaign.id, data: { action: "reopen" } },
              {
                onSuccess: () => {
                  void invalidateCampaignQueries(queryClient, organizationId, campaign.id)
                  void queryClient.invalidateQueries({ queryKey: getGetCampaignAudienceQueryKey(organizationId, campaign.id) })
                  toast({ title: "Campaign moved back to draft" })
                },
                onError: (error) => toast({ title: messageFrom(error, "Couldn't reopen the campaign"), variant: "destructive" }),
              },
            )}
          >
            {transition.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Back to draft
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (audience.status !== "Draft") {
    return (
      <Alert data-testid="banner-audience-not-draft">
        <Lock className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>The audience can't be changed now.</AlertTitle>
        <AlertDescription>Recipients can only change while the campaign is a draft (it is {audience.status.toLowerCase()}).</AlertDescription>
      </Alert>
    )
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

type UploadPhase = "idle" | "sniffing" | "configure" | "uploading" | "done" | "error"

function UploadCard({ audience, campaign, organizationId }: { audience: CampaignAudience; campaign: Campaign; organizationId: number }) {
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [sniff, setSniff] = useState<CsvSniffResult | null>(null)
  const [phase, setPhase] = useState<UploadPhase>("idle")
  const [error, setError] = useState<string | null>(null)
  const [phoneColumn, setPhoneColumn] = useState("")
  const [countryCode, setCountryCode] = useState("")
  const [operation, setOperation] = useState<"append" | "replace">("append")
  const [uploadKey, setUploadKey] = useState<string | null>(null)
  const [result, setResult] = useState<ContactImportSession | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const sniffAbort = useRef<AbortController | null>(null)
  const hasAudience = audience.totals.sessions > 0
  const editable = audience.editable

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetCampaignAudienceQueryKey(organizationId, campaign.id) }),
    invalidateCampaignQueries(queryClient, organizationId, campaign.id),
  ])

  const choose = async (selected: File | null) => {
    sniffAbort.current?.abort()
    setFile(selected)
    setSniff(null)
    setError(null)
    setResult(null)
    setPhoneColumn("")
    setCountryCode("")
    if (!selected) { setPhase("idle"); return }
    setPhase("sniffing")
    const controller = new AbortController()
    sniffAbort.current = controller
    try {
      const sniffed = await sniffCsv(organizationId, campaign.id, selected, controller.signal)
      if (controller.signal.aborted) return
      setSniff(sniffed)
      setPhoneColumn(sniffed.phoneColumnSuggestion ?? "")
      setPhase("configure")
    } catch (failure) {
      if (controller.signal.aborted) return
      setError(messageFrom(failure, "Couldn't read this file."))
      setPhase("error")
    }
  }

  const needsCountry = sniff?.countryCode.decision === "required"
  const config: UploadConfig = { phoneColumn, countryCode, operation: hasAudience ? operation : "append" }
  const canUpload = editable && !!file && !!sniff && !!phoneColumn && (!needsCountry || /^\+?\d{1,4}$/.test(countryCode.trim()))

  const upload = async () => {
    if (!file || !canUpload) return
    const key = uploadKeyFor(campaign.id, file, config)
    setUploadKey(key)
    setPhase("uploading")
    setError(null)
    void queryClient.invalidateQueries({ queryKey: getGetCampaignAudienceQueryKey(organizationId, campaign.id) })
    try {
      const session = await uploadAudienceCsv(organizationId, campaign.id, file, key, config)
      setResult(session)
      setPhase("done")
    } catch (failure) {
      const code = codeOf(failure)
      setError(code === "idempotency_mismatch"
        ? "This file was already uploaded with different settings. Choose it again to start a fresh upload."
        : messageFrom(failure, "The upload didn't finish."))
      setPhase("error")
    } finally {
      await refresh()
    }
  }

  const live = uploadKey ? audience.sessions.find((session) => session.idempotencyKey === uploadKey) : undefined
  const progress = file && live ? Math.min(100, Math.round((live.bytesProcessed / Math.max(1, file.size)) * 100)) : 0
  // A session left Processing/Failed by an earlier visit: the browser no
  // longer holds that file, so it cannot be resumed without choosing it again.
  const interrupted = audience.sessions.filter((session) => session.status !== "Completed" && session.idempotencyKey !== uploadKey)
  const latestInterrupted = interrupted[interrupted.length - 1]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{hasAudience ? "Add or replace recipients" : "Upload recipients"}</CardTitle>
        <CardDescription>A CSV with one row per recipient and a column holding their WhatsApp number. Other columns can be used as template variables later.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {latestInterrupted && phase !== "uploading" && (
          <Alert data-testid="banner-upload-interrupted">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>{latestInterrupted.status === "Processing" ? "An upload is still in progress." : "An earlier upload didn't finish."}</AlertTitle>
            <AlertDescription>
              {latestInterrupted.status === "Processing"
                ? `${latestInterrupted.fileName} is being processed. Counts update when it finishes.`
                : `${latestInterrupted.fileName} stopped after ${formatNumber(sessionDataRows(latestInterrupted))} rows${latestInterrupted.error ? ` (${latestInterrupted.error})` : ""}. Your browser doesn't keep the file after a reload; choose it again with the same settings to continue where it stopped. The audience shown above is unaffected.`}
            </AlertDescription>
          </Alert>
        )}

        <div
          role="button"
          tabIndex={editable ? 0 : -1}
          aria-disabled={!editable}
          onClick={() => editable && inputRef.current?.click()}
          onKeyDown={(event) => { if (editable && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); inputRef.current?.click() } }}
          onDragOver={(event) => { if (!editable) return; event.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            if (!editable) return
            void choose(event.dataTransfer.files?.[0] ?? null)
          }}
          className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors ${dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"} ${editable ? "cursor-pointer hover:bg-muted/40" : "cursor-not-allowed opacity-60"}`}
          data-testid="dropzone-audience-csv"
        >
          <FileUp className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          {file ? (
            <span className="break-all font-medium">{file.name}</span>
          ) : (
            <span><span className="font-medium">Drop a CSV here</span> or click to choose a file</span>
          )}
          <span className="text-xs text-muted-foreground">{editable ? "Only the first part of the file is read for the preview." : "Uploads are unavailable right now."}</span>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => { void choose(event.target.files?.[0] ?? null); event.target.value = "" }}
            data-testid="input-audience-csv"
          />
        </div>

        {phase === "sniffing" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="state-sniffing"><Loader2 className="h-4 w-4 animate-spin" /> Reading the file...</p>
        )}

        {phase === "error" && error && (
          <Alert variant="destructive" data-testid="alert-upload-error">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>That didn't work.</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {sniff && (phase === "configure" || phase === "error" || phase === "uploading" || phase === "done") && (
          <div className="space-y-4">
            <SniffPreview sniff={sniff} phoneColumn={phoneColumn} />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="audience-phone-column">Phone number column</Label>
                <Select value={phoneColumn} onValueChange={setPhoneColumn} disabled={phase === "uploading"}>
                  <SelectTrigger id="audience-phone-column" data-testid="select-audience-phone-column">
                    <SelectValue placeholder="Choose a column" />
                  </SelectTrigger>
                  <SelectContent>
                    {sniff.columns.map((column) => <SelectItem key={column} value={column}>{column}</SelectItem>)}
                  </SelectContent>
                </Select>
                {!sniff.phoneColumnSuggestion && (
                  <p className="text-xs text-muted-foreground">We couldn't tell which column holds the numbers. Choose it.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="audience-country-code">Country code{needsCountry ? "" : " (optional)"}</Label>
                <Input
                  id="audience-country-code"
                  inputMode="numeric"
                  placeholder="e.g. 44"
                  value={countryCode}
                  onChange={(event) => setCountryCode(event.target.value)}
                  disabled={phase === "uploading"}
                  aria-invalid={needsCountry && !/^\+?\d{1,4}$/.test(countryCode.trim())}
                  data-testid="input-audience-country-code"
                />
                <p className="text-xs text-muted-foreground">
                  {sniff.countryCode.decision === "required"
                    ? "Some numbers have no country code. Enter the one they all share; it is not guessed."
                    : sniff.countryCode.decision === "not_needed"
                      ? "The sampled numbers already include a country code."
                      : "Used only for numbers written without a country code."}
                </p>
              </div>
            </div>

            {hasAudience && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">What should this file do?</legend>
                <RadioGroup value={operation} onValueChange={(value) => setOperation(value as "append" | "replace")} className="gap-2" disabled={phase === "uploading"}>
                  <label className="flex items-start gap-2 text-sm">
                    <RadioGroupItem value="append" data-testid="radio-audience-append" className="mt-0.5" />
                    <span><span className="font-medium">Add to the audience.</span> Numbers already in it are kept once and counted as duplicates.</span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <RadioGroupItem value="replace" data-testid="radio-audience-replace" className="mt-0.5" />
                    <span><span className="font-medium">Replace the audience.</span> The current recipients stay in place until this upload finishes; if it fails, nothing changes.</span>
                  </label>
                </RadioGroup>
              </fieldset>
            )}

            {phase === "uploading" && (
              <div className="space-y-2" data-testid="state-uploading" aria-live="polite">
                <Progress value={progress} aria-label="Upload progress" />
                <p className="text-sm text-muted-foreground">
                  {live ? `${formatNumber(sessionDataRows(live))} rows processed` : "Starting upload..."} · keep this tab open until it finishes.
                </p>
              </div>
            )}

            {phase === "done" && result && (
              <Alert data-testid="alert-upload-done">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>{result.operation === "replace" ? "Audience replaced." : "Recipients added."}</AlertTitle>
                <AlertDescription>
                  {formatNumber(result.validRows)} ready, {formatNumber(result.invalidRows)} invalid, {formatNumber(result.suppressedRows)} opted out, {formatNumber(result.duplicateRows)} duplicates.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void upload()} disabled={!canUpload || phase === "uploading" || phase === "done"} className="gap-2" data-testid="button-start-audience-upload">
                {phase === "uploading" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {phase === "error" ? "Try again" : hasAudience && operation === "replace" ? "Replace audience" : hasAudience ? "Add recipients" : "Upload recipients"}
              </Button>
              {phase !== "uploading" && (
                <Button variant="ghost" onClick={() => void choose(null)} data-testid="button-clear-audience-file">
                  {phase === "done" ? "Upload another file" : "Choose a different file"}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SniffPreview({ sniff, phoneColumn }: { sniff: CsvSniffResult; phoneColumn: string }) {
  const phoneIndex = sniff.columns.indexOf(phoneColumn)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Preview</h3>
        <span className="text-xs text-muted-foreground" data-testid="text-sniff-scope">
          {sniff.columns.length} columns · first {formatNumber(sniff.sample.length)} rows shown
          {sniff.truncated ? " · counts are for the whole file after upload" : ""}
        </span>
      </div>
      {sniff.headerWarnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-400" data-testid="list-header-warnings">
          {sniff.headerWarnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      {sniff.sample.length === 0 ? (
        <EmptyState title="Only a header row." description="This file has column names but no recipients in the part we read." />
      ) : (
        <div className="max-w-full overflow-x-auto rounded-md border">
          <Table data-testid="table-sniff-sample">
            <TableHeader>
              <TableRow>
                {sniff.columns.map((column, index) => (
                  <TableHead key={column} className={`whitespace-nowrap ${index === phoneIndex ? "bg-primary/10 text-foreground" : ""}`}>{column}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sniff.sample.slice(0, 5).map((row, rowIndex) => (
                <TableRow key={rowIndex}>
                  {row.map((cell, index) => (
                    <TableCell key={index} className={`max-w-[16rem] truncate whitespace-nowrap ${index === phoneIndex ? "bg-primary/5 font-mono" : ""}`} title={cell}>{cell}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Upload history                                                      */
/* ------------------------------------------------------------------ */

function SessionsCard({ audience, organizationId, campaignId }: { audience: CampaignAudience; organizationId: number; campaignId: number }) {
  const sessions = useMemo(() => [...audience.sessions].reverse(), [audience.sessions])
  if (!sessions.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Uploads</CardTitle>
        <CardDescription>Download the rows that were not added, with their original columns.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {sessions.map((session) => {
            const superseded = session.status === "Completed" && session.audienceGeneration !== audience.audienceGeneration
            return (
              <li key={session.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`row-audience-session-${session.id}`}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{session.fileName}</div>
                  <div className="text-xs text-muted-foreground">
                    {session.status === "Completed"
                      ? `${session.operation === "replace" ? "Replaced audience" : "Added"} · ${formatNumber(session.validRows)} ready · ${formatNumber(session.invalidRows)} invalid · ${formatNumber(session.suppressedRows)} opted out · ${formatNumber(session.duplicateRows)} duplicates`
                      : session.status === "Processing"
                        ? `Processing · ${formatNumber(sessionDataRows(session))} rows so far`
                        : `Didn't finish · ${session.error ?? "interrupted"}`}
                    {superseded ? " · replaced by a later upload" : ""}
                  </div>
                </div>
                {session.status === "Completed" && (session.invalidRows + session.suppressedRows > 0 || session.duplicateRows > 0) && (
                  <div className="flex flex-wrap gap-2">
                    {session.invalidRows + session.suppressedRows > 0 && (
                      <Button asChild variant="outline" size="sm" className="gap-1">
                        <a href={rejectedRowsUrl(organizationId, campaignId, session.id)} download data-testid={`link-download-rejected-${session.id}`}>
                          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Rejected rows
                        </a>
                      </Button>
                    )}
                    {session.duplicateRows > 0 && (
                      <Button asChild variant="outline" size="sm" className="gap-1">
                        <a href={duplicateRowsUrl(organizationId, campaignId, session.id)} download data-testid={`link-download-duplicates-${session.id}`}>
                          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Duplicates
                        </a>
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

function BackLink() {
  return (
    <Link href="/campaigns" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back-to-campaigns">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Campaigns
    </Link>
  )
}

function NotFound() {
  return (
    <div className="space-y-6">
      <BackLink />
      <EmptyState
        size="page"
        title="Campaign not found."
        description="It may have been deleted, or it belongs to another workspace."
        primaryAction={<Button asChild><Link href="/campaigns">Back to campaigns</Link></Button>}
      />
    </div>
  )
}
