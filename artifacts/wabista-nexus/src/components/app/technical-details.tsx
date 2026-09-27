import { useId, useState } from "react"
import { Check, ChevronRight, Copy } from "lucide-react"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"

export type TechnicalField = {
  label: string
  /** Rendered in monospace. Objects are pretty-printed as JSON. */
  value: unknown
  /** Show a copy button. Only for non-sensitive identifiers/messages. */
  copyable?: boolean
}

type TechnicalDetailsProps = {
  fields: TechnicalField[]
  title?: string
  className?: string
  "data-testid"?: string
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const canCopy = typeof navigator !== "undefined" && Boolean(navigator.clipboard)
  if (!canCopy) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        } catch {
          // Clipboard access can be denied; fail quietly, the value is visible.
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

// Read-only, collapsed-by-default panel for raw IDs, codes and payloads so
// business users never see them by default while support can still
// troubleshoot. Never pass credentials or access tokens as fields.
export function TechnicalDetails({ fields, title = "Technical details", className, ...rest }: TechnicalDetailsProps) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  if (!fields.length) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("rounded-md border bg-muted/30", className)}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-controls={contentId}
        data-testid={rest["data-testid"]}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent id={contentId}>
        <dl className="space-y-2 border-t px-3 py-3">
          {fields.map((field) => {
            const text = formatValue(field.value)
            const multiline = text.includes("\n") || text.length > 80
            return (
              <div key={field.label} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
                <dt className="w-40 shrink-0 text-xs text-muted-foreground">{field.label}</dt>
                <dd className="flex min-w-0 flex-1 items-start gap-1">
                  {multiline ? (
                    <pre className="max-h-64 w-full overflow-auto rounded bg-background p-2 font-mono text-xs">{text}</pre>
                  ) : (
                    <code className="min-w-0 break-all font-mono text-xs">{text}</code>
                  )}
                  {field.copyable && text !== "—" ? <CopyButton text={text} label={field.label} /> : null}
                </dd>
              </div>
            )
          })}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}
