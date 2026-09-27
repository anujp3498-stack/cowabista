import { Skeleton } from "@/components/ui/skeleton"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

// Reusable skeleton patterns. Prefer these over "Loading..." text.

export function PageHeaderSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)} aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-9 w-full sm:w-36" />
    </div>
  )
}

export function StatStripSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)} aria-busy="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="space-y-3 rounded-lg border bg-card p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  )
}

export function TableRowsSkeleton({ rows = 5, columns }: { rows?: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <TableRow key={rowIndex} aria-busy="true">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <TableCell key={columnIndex}>
              <Skeleton className={cn("h-4", columnIndex === 0 ? "w-40 max-w-full" : "w-20 max-w-full")} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

export function CardListSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-4 md:grid-cols-2 lg:grid-cols-3", className)} aria-busy="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="space-y-3 rounded-lg border bg-card p-5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </div>
  )
}
