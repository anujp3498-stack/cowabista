import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

type PageHeaderProps = {
  title: string
  /** One short sentence. Keep it business-facing. */
  description?: string
  /** Exactly one primary call to action for the page. */
  primaryAction?: ReactNode
  /** Optional lower-emphasis actions (links, outline buttons, menus). */
  secondaryActions?: ReactNode
  /** Small context line rendered above the title (breadcrumb, parent name). */
  context?: ReactNode
  /** Optional status chip or badge rendered next to the title. */
  status?: ReactNode
  className?: string
}

// Shared page header: compact, one primary CTA, stacks on mobile with the
// primary action full-width under the text. Replaces the hand-written
// `text-3xl` header markup that every page duplicated.
export function PageHeader({
  title,
  description,
  primaryAction,
  secondaryActions,
  context,
  status,
  className,
}: PageHeaderProps) {
  const hasActions = Boolean(primaryAction || secondaryActions)
  return (
    <header className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {context ? <div className="text-xs text-muted-foreground">{context}</div> : null}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {status}
        </div>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {hasActions ? (
        <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center [&>*]:w-full sm:[&>*]:w-auto">
          {secondaryActions}
          {primaryAction}
        </div>
      ) : null}
    </header>
  )
}
