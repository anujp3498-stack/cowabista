import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import type { WhatsAppCompatibility } from "@workspace/api-client-react"
import { reasonLabel } from "@/lib/compatibility"

// Explains a selection: which selected numbers can send each selected
// template, which templates have no sender and which numbers can send
// nothing, with the server's stable reasons. Display only; the server
// enforces the same rule on save, readiness, planning and sending.

export function CompatibilityMatrix({
  data,
  isLoading,
  isError,
  numberLabel,
  "data-testid": testId,
}: {
  data: WhatsAppCompatibility | undefined
  isLoading: boolean
  isError: boolean
  numberLabel?: (phoneNumberId: number) => string
  "data-testid"?: string
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={testId ?? "compatibility-matrix"}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking which numbers can send which templates…
      </div>
    )
  }
  if (isError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" data-testid={testId ?? "compatibility-matrix"}>
        Couldn't check compatibility. The server still enforces it when you save.
      </div>
    )
  }
  if (!data || (!data.numbers.length && !data.templates.length)) {
    return (
      <div className="text-xs text-muted-foreground" data-testid={testId ?? "compatibility-matrix"}>Select numbers and templates to see which combinations can send.</div>
    )
  }
  const label = (id: number) => numberLabel?.(id) ?? data.numbers.find((n) => n.phoneNumberId === id)?.displayName ?? `#${id}`
  const problems = data.templatesWithoutNumber.length + data.numbersWithoutTemplate.length
  return (
    <div className="space-y-2" data-testid={testId ?? "compatibility-matrix"}>
      <div className={`flex items-center gap-2 text-xs font-medium ${problems ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`} data-testid="compatibility-summary">
        {problems ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
        {problems ? `${problems} ${problems === 1 ? "selection problem" : "selection problems"}` : "Every selected template has a number that can send it"}
      </div>
      <ul className="space-y-1 text-xs">
        {data.templates.map((template) => {
          const incompatible = data.incompatiblePairs.filter((pair) => pair.templateId === template.templateId)
          return (
            <li key={template.templateId} className="rounded-md border px-3 py-2" data-testid={`compatibility-template-${template.templateId}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono">{template.name || `#${template.templateId}`}</span>
                {template.eligiblePhoneNumberIds.length ? (
                  <span className="text-muted-foreground">Can send: {template.eligiblePhoneNumberIds.map(label).join(", ")}</span>
                ) : (
                  <span className="text-destructive" data-testid={`compatibility-template-problem-${template.templateId}`}>No selected number can send it</span>
                )}
              </div>
              {incompatible.length && !template.eligiblePhoneNumberIds.length ? (
                <div className="mt-1 text-muted-foreground">{[...new Set(incompatible.map((pair) => reasonLabel(pair.code)))].join(" · ")}</div>
              ) : null}
              {template.evidence ? (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Verified {template.evidence.verifiedAt ? new Date(template.evidence.verifiedAt).toLocaleString() : "locally"} via {template.evidence.source.replace("_", " ")}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {data.numbersWithoutTemplate.length ? (
        <div className="text-xs text-destructive" data-testid="compatibility-numbers-without-template">
          {data.numbersWithoutTemplate.length === 1 ? "This number cannot send any selected template: " : "These numbers cannot send any selected template: "}
          {data.numbersWithoutTemplate.map((id) => {
            const own = data.numbers.find((n) => n.phoneNumberId === id)?.code
            // A number that is itself fine but matches no selected template is explained by its pair reasons.
            const pairCodes = data.incompatiblePairs.filter((pair) => pair.phoneNumberId === id).map((pair) => pair.code)
            const code = own && own !== "eligible" && own !== "eligible_local_mock" ? own : pairCodes[0] ?? "waba_mismatch"
            return `${label(id)} (${reasonLabel(code)})`
          }).join(", ")}
        </div>
      ) : null}
    </div>
  )
}
