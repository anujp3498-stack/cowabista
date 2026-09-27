import type { ComponentType, ReactNode } from "react"
import { cn } from "@/lib/utils"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

type EmptyStateProps = {
  icon?: ComponentType<{ className?: string }>
  title: string
  /** One useful sentence. Never invent counts or activity. */
  description?: string
  primaryAction?: ReactNode
  secondaryAction?: ReactNode
  /** Use "inline" inside tables/cards, "page" for a whole-page empty view. */
  size?: "inline" | "page"
  className?: string
  "data-testid"?: string
}

// App-level wrapper over the shadcn Empty primitives so every empty view
// has the same shape: icon, short title, one sentence, one or two actions.
export function EmptyState({
  icon: Icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  size = "inline",
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <Empty
      className={cn(size === "inline" ? "border-0 p-6 md:p-8" : "border p-8 md:p-12", className)}
      data-testid={rest["data-testid"]}
    >
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon">
            <Icon className="size-5" />
          </EmptyMedia>
        ) : null}
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {primaryAction || secondaryAction ? (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {primaryAction}
          {secondaryAction}
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
