import type { Template } from "@workspace/api-client-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { StatusChip, TechnicalDetails } from "@/components/app"
import { Badge } from "@/components/ui/badge"

// Read-only preview of a synchronised Meta template, rendered from the
// provider `components` snapshot. Variables ({{1}}, {{2}}…) are highlighted.
// Nothing here is editable: content, language, category and status belong
// to Meta. No media examples are fabricated: a media header is shown as its
// kind only.

type Component = Record<string, unknown>

function componentsOf(template: Template): Component[] {
  return Array.isArray(template.components) ? (template.components as Component[]) : []
}

export function headerKind(template: Template): string | null {
  const header = componentsOf(template).find((component) => String(component.type).toUpperCase() === "HEADER")
  if (!header) return null
  return String(header.format ?? "TEXT").toUpperCase()
}

export function variableNames(text: string): string[] {
  return [...new Set(text.match(/\{\{\s*\d+\s*\}\}/g) ?? [])].map((match) => match.replace(/\s/g, ""))
}

function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\{\{\s*\d+\s*\}\})/g)
  return (
    <>
      {parts.map((part, index) =>
        /^\{\{\s*\d+\s*\}\}$/.test(part) ? (
          <span key={index} className="rounded bg-primary/10 px-1 font-mono text-primary">{part.replace(/\s/g, "")}</span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  )
}

export function TemplatePreviewDialog({ template, onOpenChange }: { template: Template | null; onOpenChange: (open: boolean) => void }) {
  const components = template ? componentsOf(template) : []
  const header = components.find((component) => String(component.type).toUpperCase() === "HEADER")
  const body = components.find((component) => String(component.type).toUpperCase() === "BODY")
  const footer = components.find((component) => String(component.type).toUpperCase() === "FOOTER")
  const buttons = components.find((component) => String(component.type).toUpperCase() === "BUTTONS")
  const buttonList = Array.isArray(buttons?.buttons) ? (buttons!.buttons as Component[]) : []
  const bodyText = typeof body?.text === "string" ? body.text : template?.body ?? ""
  const headerFormat = String(header?.format ?? "TEXT").toUpperCase()
  const variables = [
    ...(typeof header?.text === "string" ? variableNames(header.text) : []),
    ...variableNames(bodyText),
    ...buttonList.flatMap((button) => (typeof button.url === "string" ? variableNames(button.url) : [])),
  ]

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
          <div className="space-y-4" data-testid="template-preview">
            <div className="rounded-lg border bg-muted/30 p-4 text-sm">
              {header ? (
                <div className="mb-3">
                  {headerFormat === "TEXT" && typeof header.text === "string" ? (
                    <p className="font-semibold"><Highlighted text={header.text} /></p>
                  ) : (
                    <div className="flex h-20 items-center justify-center rounded-md border border-dashed text-xs uppercase tracking-wide text-muted-foreground" data-testid="preview-media-header">
                      {headerFormat.toLowerCase()} header
                    </div>
                  )}
                </div>
              ) : null}
              <p className="whitespace-pre-wrap" data-testid="preview-body"><Highlighted text={bodyText} /></p>
              {typeof footer?.text === "string" ? <p className="mt-3 text-xs text-muted-foreground">{footer.text}</p> : null}
              {buttonList.length ? (
                <div className="mt-3 space-y-1 border-t pt-3">
                  {buttonList.map((button, index) => (
                    <div key={index} className="rounded-md border bg-background px-3 py-1.5 text-center text-sm text-primary" data-testid={`preview-button-${index}`}>
                      {String(button.text ?? button.type ?? "Button")}
                      {typeof button.url === "string" ? <span className="ml-2 text-xs text-muted-foreground"><Highlighted text={button.url} /></span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">
              {variables.length
                ? <>Variables to fill: {[...new Set(variables)].map((name) => <code key={name} className="mr-1 rounded bg-muted px-1 font-mono">{name}</code>)}</>
                : "This template has no variables."}
            </div>
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
