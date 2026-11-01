import { useId, useState, type ReactNode } from "react"
import { ChevronRight, Settings2 } from "lucide-react"
import { useListCampaignRoutes } from "@workspace/api-client-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// "Advanced settings": technical configuration (sending routes, engine
// details) that business users do not need, collapsed by default.

export function AdvancedSettings({ title = "Advanced settings", description, children, defaultOpen = false, "data-testid": testId = "advanced-settings" }: {
  title?: string
  description?: string
  children: ReactNode
  defaultOpen?: boolean
  "data-testid"?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const contentId = useId()
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border" data-testid={testId}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
        aria-controls={contentId}
        data-testid={`${testId}-toggle`}
      >
        <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} aria-hidden="true" />
        <Settings2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block">{title}</span>
          {description ? <span className="block text-xs font-normal text-muted-foreground">{description}</span> : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent id={contentId} className="space-y-4 border-t p-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Read-only sending routes of one campaign: one lane per number for a typed
 * campaign (derived from its numbers, templates and speed; never edited by
 * hand), with the live target speed, current speed and queue depth.
 */
export function CampaignRouteLanes({ campaignId }: { campaignId: number }) {
  const routesQuery = useListCampaignRoutes({ campaignId })
  const routes = routesQuery.data ?? []
  if (routesQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading routes...</p>
  if (routesQuery.isError) return <p className="text-sm text-destructive">Couldn't load the routes.</p>
  if (!routes.length) return <p className="text-sm text-muted-foreground" data-testid="route-lanes-empty">No routes yet: they are created when the numbers and templates are saved.</p>
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Routes are created automatically from the numbers, templates and speed you chose (one per number). To change them, change those steps.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <Table data-testid="route-lanes">
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Default template</TableHead>
              <TableHead className="text-right">Target speed</TableHead>
              <TableHead className="text-right">Current speed</TableHead>
              <TableHead className="text-right">Queue</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.map((route) => (
              <TableRow key={route.id} data-testid={`route-lane-${route.id}`}>
                <TableCell className="font-mono text-xs">{route.phoneNumber}</TableCell>
                <TableCell className="text-xs">{route.templateName ?? "—"}</TableCell>
                <TableCell className="text-right font-mono text-xs">{route.configuredTps}/s</TableCell>
                <TableCell className="text-right font-mono text-xs">{route.currentTps}/s</TableCell>
                <TableCell className="text-right font-mono text-xs">{route.queueDepth}</TableCell>
                <TableCell><Badge variant="outline">{route.status}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
