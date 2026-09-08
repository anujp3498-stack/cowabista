import { useEffect, useRef, useState } from "react"
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
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AlertTriangle, CheckCircle2, Download, Loader2, Upload } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useQueryClient } from "@tanstack/react-query"
import {
  getListContactImportsQueryKey,
  getGetCampaignMonitoringQueryKey,
  getListCampaignsQueryKey,
  getDownloadRejectedImportRowsUrl,
  getStreamContactImportUrl,
  listContactImports,
  type Campaign,
  type ContactImportSession,
} from "@workspace/api-client-react"

type Phase = "config" | "uploading" | "done" | "error"

// Parses only the first CSV header line from a small slice of the file (not
// the whole file) so the column picker works even for a multi-GB CSV.
async function readHeaderColumns(file: File): Promise<string[]> {
  const head = await file.slice(0, 65536).text()
  const firstLine = head.split(/\r\n|\n|\r/, 1)[0] ?? ""
  const cells: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < firstLine.length; i++) {
    const char = firstLine[i]
    if (quoted) {
      if (char === '"' && firstLine[i + 1] === '"') { field += '"'; i++; continue }
      if (char === '"') { quoted = false; continue }
      field += char
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ",") { cells.push(field.trim()); field = ""; continue }
    field += char
  }
  cells.push(field.trim())
  return cells.filter(Boolean)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// Uploads the raw CSV as a streamed request body (never buffered into a JS
// string), matching the backend's streaming import contract. Not built on
// the generated `useStreamContactImport` hook: orval's binary-body codegen
// JSON.stringifies the Blob body instead of sending raw bytes, which would
// silently corrupt every upload.
async function uploadCsv({
  organizationId,
  campaignId,
  file,
  idempotencyKey,
  phoneColumn,
  countryCode,
}: {
  organizationId: number
  campaignId: number
  file: File
  idempotencyKey: string
  phoneColumn: string
  countryCode: string
}): Promise<ContactImportSession> {
  const res = await fetch(getStreamContactImportUrl(organizationId, campaignId), {
    method: "POST",
    headers: {
      "Content-Type": "text/csv",
      "idempotency-key": idempotencyKey,
      "x-file-name": file.name,
      "x-phone-column": phoneColumn,
      ...(countryCode.trim() ? { "x-default-country-code": countryCode.trim() } : {}),
    },
    body: file,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error((body && typeof body === "object" && "error" in body && String(body.error)) || `Import failed (HTTP ${res.status})`)
  }
  return body as ContactImportSession
}

// Manager-facing CSV import: upload, live progress (polled from the
// session row the backend updates as it streams), and a results summary
// with a rejected-rows download. The file is streamed to the server as
// raw bytes (never loaded fully into JS memory or buffered as
// base64/JSON), and the backend persists progress incrementally so an
// interrupted upload can be retried with the same idempotency key and
// resumes instead of restarting. Do not claim a specific proven contact
// scale in user-facing copy here -- that has not been load-tested.
export function ContactImportDialog({
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
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [columns, setColumns] = useState<string[]>([])
  const [phoneColumn, setPhoneColumn] = useState("")
  const [countryCode, setCountryCode] = useState("")
  const [phase, setPhase] = useState<Phase>("config")
  const [session, setSession] = useState<ContactImportSession | null>(null)
  const [errorMessage, setErrorMessage] = useState("")
  const idempotencyKeyRef = useRef("")
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const resetForm = () => {
    stopPolling()
    setFile(null)
    setColumns([])
    setPhoneColumn("")
    setCountryCode("")
    setPhase("config")
    setSession(null)
    setErrorMessage("")
    idempotencyKeyRef.current = ""
  }

  useEffect(() => {
    if (!open) resetForm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => stopPolling(), [])

  const handleFileChange = async (selected: File | null) => {
    setFile(selected)
    setColumns([])
    setPhoneColumn("")
    if (!selected) return
    try {
      const parsed = await readHeaderColumns(selected)
      setColumns(parsed)
      const guess = parsed.find((c) => /phone|mobile|whatsapp|number/i.test(c))
      if (guess) setPhoneColumn(guess)
    } catch {
      toast({ title: "Couldn't read the CSV header row", variant: "destructive" })
    }
  }

  const startPolling = (campaignId: number, key: string) => {
    pollRef.current = setInterval(async () => {
      if (!organizationId) return
      try {
        const sessions = await listContactImports(organizationId, campaignId)
        const match = sessions.find((s) => s.idempotencyKey === key)
        if (match && mountedRef.current) setSession(match)
      } catch {
        // Transient polling failures are not fatal -- the upload request
        // itself is the source of truth for success/failure.
      }
    }, 1200)
  }

  const runUpload = async () => {
    if (!organizationId || !campaign || !file || !phoneColumn) return
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID()
    setPhase("uploading")
    setErrorMessage("")
    startPolling(campaign.id, idempotencyKeyRef.current)
    try {
      const result = await uploadCsv({
        organizationId,
        campaignId: campaign.id,
        file,
        idempotencyKey: idempotencyKeyRef.current,
        phoneColumn,
        countryCode,
      })
      stopPolling()
      if (!mountedRef.current) return
      setSession(result)
      setPhase("done")
      queryClient.invalidateQueries({ queryKey: getListContactImportsQueryKey(organizationId, campaign.id) })
      queryClient.invalidateQueries({ queryKey: getGetCampaignMonitoringQueryKey(organizationId, campaign.id) })
      // A successful import can update the campaign's own audienceSize
      // (draft campaigns only -- see the backend handler), which the
      // Rocket Campaigns card reads straight off the campaigns list query.
      // Without this, "Audience" shows stale data (often 0) until an
      // unrelated refetch or a manual page reload happens to run.
      queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() })
      const rejected = result.invalidRows + result.suppressedRows
      toast({
        title: "Import complete",
        description: `${result.validRows} usable, ${rejected} rejected, ${result.duplicateRows} duplicate of ${result.rowsProcessed} rows.`,
      })
    } catch (error) {
      stopPolling()
      if (!mountedRef.current) return
      setPhase("error")
      setErrorMessage(error instanceof Error ? error.message : "Import failed")
    }
  }

  const rejectedCount = session ? session.invalidRows + session.suppressedRows : 0
  const progressPct = session && file && file.size > 0
    ? Math.min(100, Math.round((session.bytesProcessed / file.size) * 100))
    : phase === "uploading" ? 5 : 0

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && phase !== "uploading") onOpenChange(next); else if (next) onOpenChange(next) }}>
      <DialogContent className="max-w-lg" data-testid="dialog-contact-import">
        <DialogHeader>
          <DialogTitle>Import contacts — {campaign?.name}</DialogTitle>
          <DialogDescription>
            Upload a CSV of recipients for this campaign. Files are streamed straight to the queue -- nothing is held in your browser's memory, so large lists won't stall or crash your browser.
          </DialogDescription>
        </DialogHeader>

        {phase === "config" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="import-file">CSV file</Label>
              <Input
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                data-testid="input-import-file"
                onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
              />
              {file && (
                <p className="text-xs text-muted-foreground">{file.name} · {formatBytes(file.size)}</p>
              )}
            </div>
            {columns.length > 0 && (
              <>
                <div className="space-y-2">
                  <Label>Phone number column</Label>
                  <Select value={phoneColumn} onValueChange={setPhoneColumn}>
                    <SelectTrigger data-testid="select-import-phone-column">
                      <SelectValue placeholder="Choose the column with phone numbers" />
                    </SelectTrigger>
                    <SelectContent>
                      {columns.map((column) => (
                        <SelectItem key={column} value={column}>{column}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="import-country-code">Default country code (optional)</Label>
                  <Input
                    id="import-country-code"
                    placeholder="e.g. 1 for numbers without a country code"
                    value={countryCode}
                    onChange={(e) => setCountryCode(e.target.value)}
                    data-testid="input-import-country-code"
                  />
                  <p className="text-xs text-muted-foreground">
                    Used only for rows whose number doesn't already start with a country code. Numbers already in international format (+...) are unaffected.
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {(phase === "uploading" || phase === "done" || phase === "error") && (
          <div className="space-y-4">
            {phase === "uploading" && (
              <div className="space-y-2" data-testid="import-progress">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  Uploading and validating rows -- keep this tab open until this finishes.
                </div>
                <Progress value={progressPct} />
                {session && (
                  <p className="text-xs text-muted-foreground font-mono">
                    {formatBytes(session.bytesProcessed)} processed · {session.rowsProcessed.toLocaleString()} rows seen ·
                    {" "}{session.validRows.toLocaleString()} valid · {session.invalidRows.toLocaleString()} invalid ·
                    {" "}{session.suppressedRows.toLocaleString()} suppressed · {session.duplicateRows.toLocaleString()} duplicate
                  </p>
                )}
              </div>
            )}

            {phase === "done" && session && (
              <div className="space-y-3" data-testid="import-results">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> Import complete
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm rounded-md border p-3">
                  <div><span className="text-muted-foreground text-xs block">Rows processed</span>{session.rowsProcessed.toLocaleString()}</div>
                  <div><span className="text-muted-foreground text-xs block">Usable (valid)</span>{session.validRows.toLocaleString()}</div>
                  <div><span className="text-muted-foreground text-xs block">Invalid phone</span>{session.invalidRows.toLocaleString()}</div>
                  <div><span className="text-muted-foreground text-xs block">Suppressed (opted out)</span>{session.suppressedRows.toLocaleString()}</div>
                  <div><span className="text-muted-foreground text-xs block">Duplicate (already imported)</span>{session.duplicateRows.toLocaleString()}</div>
                </div>
                {rejectedCount > 0 && organizationId && campaign && (
                  <Button asChild variant="outline" size="sm" className="gap-2" data-testid="button-download-rejected-rows">
                    <a href={getDownloadRejectedImportRowsUrl(organizationId, campaign.id, session.id)} download>
                      <Download className="h-4 w-4" />
                      Download {rejectedCount.toLocaleString()} rejected row{rejectedCount === 1 ? "" : "s"} (CSV)
                    </a>
                  </Button>
                )}
                {session.duplicateRows > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Duplicate rows matched a number already in this campaign, so their original file content isn't kept separately.
                  </p>
                )}
              </div>
            )}

            {phase === "error" && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="import-error">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Import stopped</p>
                  <p className="text-xs">{errorMessage}</p>
                  {session && (
                    <p className="text-xs mt-1 text-muted-foreground">
                      {session.rowsProcessed.toLocaleString()} rows were already saved -- retrying resumes from there instead of starting over.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {phase === "config" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-import">Cancel</Button>
              <Button onClick={runUpload} disabled={!file || !phoneColumn} className="gap-2" data-testid="button-start-import">
                <Upload className="h-4 w-4" /> Start import
              </Button>
            </>
          )}
          {phase === "uploading" && (
            <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-hide-import">
              Hide (import continues)
            </Button>
          )}
          {phase === "done" && (
            <>
              <Button variant="outline" onClick={resetForm} data-testid="button-import-another">Import another file</Button>
              <Button onClick={() => onOpenChange(false)} data-testid="button-close-import">Done</Button>
            </>
          )}
          {phase === "error" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-close-import-error">Close</Button>
              <Button onClick={runUpload} data-testid="button-retry-import">Retry</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
