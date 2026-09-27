import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { statusPresentation, type StatusKind } from "@/lib/status"

type StatusChipProps = {
  kind: StatusKind
  value: string | null | undefined
  className?: string
  "data-testid"?: string
}

// One component for every status badge. Text is always present so the state
// never relies on colour alone.
export function StatusChip({ kind, value, className, ...rest }: StatusChipProps) {
  const { label, variant } = statusPresentation(kind, value)
  return (
    <Badge variant={variant} className={cn("whitespace-nowrap", className)} data-testid={rest["data-testid"]}>
      {label}
    </Badge>
  )
}
