import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListTemplates,
  useListContactImports,
  useGetCampaignTemplateMappings,
  useReplaceCampaignTemplateMappings,
  getGetCampaignTemplateMappingsQueryKey,
  getListCampaignsQueryKey,
  type Campaign,
  type Template,
  type TemplateMappingRecord,
} from "@workspace/api-client-react"
import { useToast } from "@/hooks/use-toast"
import { messageFrom, errorDetailsFrom } from "@/lib/api-errors"
import { describeTemplate, labelForRequirement, parseRequirement, type TemplateDescriptor } from "@/lib/template-variables"

type MappingForm = {
  source: "csv" | "static"
  sourceValue: string
  optional: boolean
  fallbackValue: string
}

const EMPTY_FORM: MappingForm = { source: "csv", sourceValue: "", optional: false, fallbackValue: "" }

export function TemplateMappingDialog({
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
  const campaignId = campaign?.id
  const hasContext = !!organizationId && !!campaignId

  // Orval-generated list/get hooks type `options.query` as a full
  // UseQueryOptions (requires `queryKey`), so a partial `{ enabled }` object
  // fails to type-check. Omit the options arg and rely on the hook's own
  // default `enabled` (id !== null/undefined) instead -- campaignId is only
  // defined here exactly while the dialog is open, so this already gates
  // correctly without a separate `open` check.
  const { data: templates } = useListTemplates()
  const { data: imports } = useListContactImports(organizationId as number, campaignId as number)
  const {
    data: report,
    isLoading: reportLoading,
    isError: reportErrored,
  } = useGetCampaignTemplateMappings(organizationId as number, campaignId as number)
  const replaceMutation = useReplaceCampaignTemplateMappings()

  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [forms, setForms] = useState<Record<string, MappingForm>>({})
  const [initializedFor, setInitializedFor] = useState<number | null>(null)

  useEffect(() => {
    if (!open) {
      setInitializedFor(null)
      return
    }
    if (!campaignId || !report || initializedFor === campaignId) return
    setSelectedIds(report.templates.map((t) => t.templateId))
    const next: Record<string, MappingForm> = {}
    for (const mapping of report.mappings) {
      next[`${mapping.component}:${mapping.variable}`] = {
        source: mapping.source,
        sourceValue: mapping.sourceValue,
        optional: mapping.optional ?? false,
        fallbackValue: mapping.fallbackValue ?? "",
      }
    }
    setForms(next)
    setInitializedFor(campaignId)
  }, [open, campaignId, report, initializedFor])

  // Mirror the backend's readiness check (campaign-preflight.ts), which only
  // validates CSV mappings against the latest *completed* import -- offering
  // columns from older or still-processing imports here would suggest
  // values that fail validation the moment the manager tries to plan.
  const latestCompletedImport = useMemo(() => {
    const completed = (imports ?? []).filter((session) => session.status === "Completed")
    if (!completed.length) return null
    return completed.reduce((latest, session) =>
      new Date(session.updatedAt).getTime() > new Date(latest.updatedAt).getTime() ? session : latest,
    )
  }, [imports])

  const csvColumns = useMemo(
    () => [...(latestCompletedImport?.columns ?? [])].sort(),
    [latestCompletedImport],
  )
  const hasCompletedImport = !!latestCompletedImport

  const selectedTemplates = useMemo(
    () => (templates ?? []).filter((t: Template) => selectedIds.includes(t.id)),
    [templates, selectedIds],
  )

  const descriptors = useMemo<TemplateDescriptor[]>(
    () => selectedTemplates.map((t: Template) => describeTemplate(t)),
    [selectedTemplates],
  )

  const headerKinds = new Set(descriptors.map((d) => d.headerKind).filter((k) => k !== "none"))
  const headerIncompatible = headerKinds.size > 1

  // One row per unique requirement key across every selected template --
  // this mirrors the backend's expandCompatibleMappings(), which shares a
  // single mapping across every template that needs the same key.
  const requirementRows = useMemo(() => {
    const byKey = new Map<string, number[]>()
    for (const descriptor of descriptors) {
      for (const requirement of descriptor.requiredVariables) {
        const list = byKey.get(requirement) ?? []
        list.push(descriptor.templateId)
        byKey.set(requirement, list)
      }
    }
    return [...byKey.entries()].map(([requirement, templateIds]) => ({ requirement, templateIds }))
  }, [descriptors])

  const templateName = (id: number) => templates?.find((t: Template) => t.id === id)?.name ?? `#${id}`

  const setForm = (key: string, patch: Partial<MappingForm>) => {
    setForms((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_FORM), ...patch } }))
  }

  const unresolvedCount = requirementRows.filter(({ requirement }) => {
    const form = forms[requirement]
    if (!form || !form.sourceValue.trim()) return true
    if (form.optional && !form.fallbackValue.trim()) return true
    return false
  }).length

  // A CSV mapping to a column absent from the latest completed import isn't
  // just unmapped -- it's mapped to something readiness will reject outright
  // (campaign-preflight.ts). Surface that distinctly so a manager doesn't
  // save a mapping that "looks complete" but still blocks Plan.
  const missingColumnCount = hasCompletedImport
    ? requirementRows.filter(({ requirement }) => {
        const form = forms[requirement]
        if (!form || form.source !== "csv" || !form.sourceValue.trim()) return false
        if (form.optional && form.fallbackValue.trim()) return false
        return !csvColumns.includes(form.sourceValue.trim())
      }).length
    : 0

  const handleSave = () => {
    if (!organizationId || !campaignId) return
    const mappings: TemplateMappingRecord[] = requirementRows.map(({ requirement }) => {
      const { component, variable } = parseRequirement(requirement)
      const form = forms[requirement] ?? EMPTY_FORM
      return {
        templateId: requirementRows.find((r) => r.requirement === requirement)!.templateIds[0]!,
        component,
        variable,
        source: form.source,
        sourceValue: form.sourceValue.trim(),
        optional: form.source === "csv" ? form.optional : false,
        fallbackValue: form.source === "csv" && form.optional ? form.fallbackValue.trim() : null,
      }
    })
    replaceMutation.mutate(
      { organizationId, campaignId, data: { templateIds: selectedIds, mappings } },
      {
        onSuccess: async () => {
          // Await the refetch (not just the invalidation) before closing, so
          // the cache is guaranteed fresh by the time this same dialog can be
          // reopened -- otherwise a very fast reopen can race the background
          // refetch and briefly render the pre-save state.
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getGetCampaignTemplateMappingsQueryKey(organizationId, campaignId) }),
            queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() }),
          ])
          toast({ title: "Template mappings saved" })
          onOpenChange(false)
        },
        onError: (error) => {
          const details = errorDetailsFrom(error)
          toast({
            title: messageFrom(error, "Failed to save template mappings"),
            description: details?.join(" "),
            variant: "destructive",
          })
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="dialog-template-mappings">
        <DialogHeader>
          <DialogTitle>Templates &amp; Variables — {campaign?.name}</DialogTitle>
          <DialogDescription>
            Pick which templates this campaign sends and map each variable to a CSV column or a fixed value.
            This must be done before the campaign can go Ready.
          </DialogDescription>
        </DialogHeader>

        {reportLoading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        )}
        {reportErrored && (
          <div className="text-sm text-destructive py-4">Failed to load template mappings.</div>
        )}

        {!reportLoading && !reportErrored && (
          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="space-y-5">
              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground tracking-wide">Templates used by this campaign</Label>
                <div className="space-y-2 rounded-md border p-3">
                  {(templates ?? []).length === 0 && (
                    <p className="text-sm text-muted-foreground">No templates found. Create one on the Templates page first.</p>
                  )}
                  {(templates ?? []).map((t: Template) => (
                    <label key={t.id} className="flex items-center gap-2 text-sm" data-testid={`checkbox-template-${t.id}`}>
                      <Checkbox
                        checked={selectedIds.includes(t.id)}
                        onCheckedChange={(checked) =>
                          setSelectedIds((prev) =>
                            checked ? [...prev, t.id] : prev.filter((id) => id !== t.id),
                          )
                        }
                      />
                      <span className="font-medium">{t.name}</span>
                      <Badge variant="outline" className="text-[10px] py-0 h-5">{t.category}</Badge>
                      <span className="text-xs text-muted-foreground">{t.language}</span>
                    </label>
                  ))}
                </div>
                {headerIncompatible && (
                  <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-destructive text-xs">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>
                      Selected templates mix different header media types (e.g. image + video). Every template in a
                      campaign must share the same header type.
                    </span>
                  </div>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs uppercase text-muted-foreground tracking-wide">Variable mapping</Label>
                  {requirementRows.length > 0 && (
                    <span
                      className={`text-xs flex items-center gap-1 ${
                        unresolvedCount > 0 || missingColumnCount > 0 ? "text-amber-600" : "text-green-600"
                      }`}
                      data-testid="text-mapping-progress"
                    >
                      {unresolvedCount === 0 && missingColumnCount === 0 ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5" />
                      )}
                      {unresolvedCount === 0 && missingColumnCount === 0
                        ? "All variables mapped"
                        : [
                            unresolvedCount > 0 ? `${unresolvedCount} of ${requirementRows.length} unmapped` : null,
                            missingColumnCount > 0
                              ? `${missingColumnCount} mapped to a column missing from the latest import`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                  )}
                </div>

                {requirementRows.length > 0 && !hasCompletedImport && (
                  <div className="flex items-start gap-2 rounded-md bg-muted p-2 text-muted-foreground text-xs">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>
                      No completed contact import yet, so CSV column names can&apos;t be checked here. Import
                      contacts first to catch typos before the campaign is planned.
                    </span>
                  </div>
                )}

                {requirementRows.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {selectedIds.length === 0
                      ? "Select at least one template above to see its variables."
                      : "Selected templates have no variables to map."}
                  </p>
                )}

                <div className="space-y-4">
                  {requirementRows.map(({ requirement, templateIds }) => {
                    const form = forms[requirement] ?? EMPTY_FORM
                    const trimmedValue = form.sourceValue.trim()
                    const toleratesMissingColumn = form.optional && !!form.fallbackValue.trim()
                    const columnMissing =
                      hasCompletedImport &&
                      form.source === "csv" &&
                      !!trimmedValue &&
                      !toleratesMissingColumn &&
                      !csvColumns.includes(trimmedValue)
                    return (
                      <div
                        key={requirement}
                        className={`rounded-md border p-3 space-y-2 ${columnMissing ? "border-destructive/50" : ""}`}
                        data-testid={`row-mapping-${requirement}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{labelForRequirement(requirement)}</span>
                          <span className="text-xs text-muted-foreground truncate max-w-[45%]" title={templateIds.map(templateName).join(", ")}>
                            Used by: {templateIds.map(templateName).join(", ")}
                          </span>
                        </div>
                        <RadioGroup
                          value={form.source}
                          onValueChange={(v) => setForm(requirement, { source: v as "csv" | "static" })}
                          className="flex gap-4"
                        >
                          <label className="flex items-center gap-1.5 text-xs">
                            <RadioGroupItem value="csv" /> CSV column
                          </label>
                          <label className="flex items-center gap-1.5 text-xs">
                            <RadioGroupItem value="static" /> Fixed value
                          </label>
                        </RadioGroup>
                        <Input
                          list={form.source === "csv" && csvColumns.length ? "csv-columns" : undefined}
                          placeholder={form.source === "csv" ? "CSV column name (e.g. first_name)" : "Fixed text or URL"}
                          value={form.sourceValue}
                          onChange={(e) => setForm(requirement, { sourceValue: e.target.value })}
                          className={columnMissing ? "border-destructive focus-visible:ring-destructive" : undefined}
                          aria-invalid={columnMissing || undefined}
                          data-testid={`input-mapping-value-${requirement}`}
                        />
                        {columnMissing && (
                          <p className="flex items-center gap-1 text-xs text-destructive" data-testid={`text-missing-column-${requirement}`}>
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            {`Column "${trimmedValue}" isn't in the latest import (${csvColumns.length ? csvColumns.join(", ") : "no columns"}). Planning will reject this until it's fixed.`}
                          </p>
                        )}
                        {form.source === "csv" && (
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={form.optional}
                              onCheckedChange={(checked) => setForm(requirement, { optional: !!checked })}
                              id={`optional-${requirement}`}
                            />
                            <Label htmlFor={`optional-${requirement}`} className="text-xs font-normal">
                              Optional — use a fallback if this column is blank for a contact
                            </Label>
                          </div>
                        )}
                        {form.source === "csv" && form.optional && (
                          <Input
                            placeholder="Fallback value"
                            value={form.fallbackValue}
                            onChange={(e) => setForm(requirement, { fallbackValue: e.target.value })}
                            data-testid={`input-mapping-fallback-${requirement}`}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
                {csvColumns.length > 0 && (
                  <datalist id="csv-columns">
                    {csvColumns.map((column) => (
                      <option key={column} value={column} />
                    ))}
                  </datalist>
                )}
              </div>
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-template-mappings">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={replaceMutation.isPending || reportLoading || !hasContext}
            data-testid="button-save-template-mappings"
          >
            {replaceMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
