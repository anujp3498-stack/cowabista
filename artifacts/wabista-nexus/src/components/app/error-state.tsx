import type { ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { describeApiError } from "@/lib/api-errors"
import { TechnicalDetails } from "@/components/app/technical-details"

type ErrorStateProps = {
  /** What happened, in plain words. Example: "Couldn't load campaigns." */
  title: string
  /** What the user can do or expect. Defaults to a safe generic sentence. */
  description?: string
  /** The thrown value, used only for the collapsed Technical Details panel. */
  error?: unknown
  onRetry?: () => void
  retryLabel?: string
  extraActions?: ReactNode
  size?: "inline" | "page"
  className?: string
  "data-testid"?: string
}

// Answers "what happened?" and "what can I do?" without leading with raw
// error text. The server message and status are available under Technical
// Details for troubleshooting.
export function ErrorState({
  title,
  description = "The server didn't respond as expected. Your data has not been changed.",
  error,
  onRetry,
  retryLabel = "Try again",
  extraActions,
  size = "inline",
  className,
  ...rest
}: ErrorStateProps) {
  const described = error !== undefined ? describeApiError(error, "Unknown error") : null
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-4 rounded-lg border border-destructive/30 bg-destructive/5 text-center",
        size === "inline" ? "p-6" : "p-8 md:p-12",
        className,
      )}
      data-testid={rest["data-testid"]}
    >
      <div className="flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <AlertTriangle className="size-5" aria-hidden="true" />
      </div>
      <div className="max-w-md space-y-1">
        <p className="text-base font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
        {described?.details?.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-left text-sm text-muted-foreground">
            {described.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {onRetry || extraActions ? (
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button type="button" variant="outline" onClick={onRetry} className="gap-2">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {retryLabel}
            </Button>
          ) : null}
          {extraActions}
        </div>
      ) : null}
      {described ? (
        <TechnicalDetails
          className="w-full max-w-md text-left"
          fields={[
            { label: "Message", value: described.message },
            ...(described.status !== null ? [{ label: "HTTP status", value: described.status }] : []),
            ...(described.raw !== null && described.raw !== undefined && typeof described.raw !== "string"
              ? [{ label: "Response", value: described.raw }]
              : []),
          ]}
        />
      ) : null}
    </div>
  )
}
