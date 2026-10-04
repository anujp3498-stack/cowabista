import type { Template } from "@workspace/api-client-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { StatusChip, TechnicalDetails } from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { TemplatePreview } from "./template-preview"

// Read-only preview of a synchronised Meta template, rendered from the
// provider `components` snapshot through the shared TemplatePreview.
// Nothing here is editable: content, language, category and status belong
// to Meta.

type Component = Record<string, unknown>

function componentsOf(template: Template): Component[] {
  return Array.isArray(template.components) ? (template.components as Component[]) : []
}

export function headerKind(template: Template): string | null {
  const header = componentsOf(template).find((component) => String(component.type).toUpperCase() === "HEADER")
  if (!header) return null
  return String(header.format ?? "TEXT").toUpperCase()
}

export { variableNames } from "./template-preview"

export function TemplatePreviewDialog({ template, onOpenChange }: { template: Template | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={template !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{template?.name}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            {template ? <StatusChip kind="template" value={template.status} /> : null}
            {template ? <span className="text-xs">{template.language} · {template.category}</span> : null}
            {template?.providerMissing ? <Badge variant="outline">No longer at Meta</Badge> : null}
          </DialogDescription>
        </DialogHeader>
        {template ? (
          <div className="space-y-4">
            <TemplatePreview components={componentsOf(template)} bodyFallback={template.body ?? ""} />
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <Fact label="Business account" value={template.wabaDisplayName ?? template.wabaExternalId ?? "—"} />
              <Fact label="Last synced" value={template.lastSyncedAt ? new Date(template.lastSyncedAt).toLocaleString() : "Never"} />
            </div>
            <TechnicalDetails
              fields={[
                { label: "Provider template ID", value: template.providerTemplateId, copyable: true },
                { label: "Template ID", value: template.id },
                { label: "WABA ID", value: template.wabaExternalId, copyable: true },
                { label: "Provider status", value: template.providerStatus },
                { label: "Source", value: template.source },
                { label: "Components", value: template.components ?? [] },
              ]}
              data-testid="technical-template"
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  )
}
