// Shared WhatsApp-style rendering of template components. Used by the
// read-only preview of a synced Meta template and by the draft editor's
// live preview, so what a person authors is shown exactly the way a synced
// template is. No media example is fabricated: a media header shows its
// kind only.

type Component = Record<string, unknown>

export function variableNames(text: string): string[] {
  return [...new Set(text.match(/\{\{\s*\d+\s*\}\}/g) ?? [])].map((match) => match.replace(/\s/g, ""))
}

export function Highlighted({ text }: { text: string }) {
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

export function findComponent(components: Component[], type: string): Component | undefined {
  return components.find((component) => String(component.type).toUpperCase() === type)
}

export function collectVariables(components: Component[], bodyFallback = ""): string[] {
  const header = findComponent(components, "HEADER")
  const body = findComponent(components, "BODY")
  const buttons = findComponent(components, "BUTTONS")
  const buttonList = Array.isArray(buttons?.buttons) ? (buttons!.buttons as Component[]) : []
  const bodyText = typeof body?.text === "string" ? body.text : bodyFallback
  return [
    ...(typeof header?.text === "string" ? variableNames(header.text) : []),
    ...variableNames(bodyText),
    ...buttonList.flatMap((button) => (typeof button.url === "string" ? variableNames(button.url) : [])),
  ]
}

export function TemplatePreview({ components, bodyFallback = "", emptyBodyHint, "data-testid": testId }: { components: Component[]; bodyFallback?: string; emptyBodyHint?: string; "data-testid"?: string }) {
  const header = findComponent(components, "HEADER")
  const body = findComponent(components, "BODY")
  const footer = findComponent(components, "FOOTER")
  const buttons = findComponent(components, "BUTTONS")
  const buttonList = Array.isArray(buttons?.buttons) ? (buttons!.buttons as Component[]) : []
  const bodyText = typeof body?.text === "string" ? body.text : bodyFallback
  const headerFormat = String(header?.format ?? "TEXT").toUpperCase()
  const variables = collectVariables(components, bodyFallback)

  return (
    <div className="space-y-3" data-testid={testId ?? "template-preview"}>
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
        {bodyText.trim() ? (
          <p className="whitespace-pre-wrap" data-testid="preview-body"><Highlighted text={bodyText} /></p>
        ) : (
          <p className="text-muted-foreground" data-testid="preview-body">{emptyBodyHint ?? ""}</p>
        )}
        {typeof footer?.text === "string" ? <p className="mt-3 text-xs text-muted-foreground">{footer.text}</p> : null}
        {buttonList.length ? (
          <div className="mt-3 space-y-1 border-t pt-3">
            {buttonList.map((button, index) => (
              <div key={index} className="rounded-md border bg-background px-3 py-1.5 text-center text-sm text-primary" data-testid={`preview-button-${index}`}>
                {String(button.text ?? button.type ?? "Button")}
                {typeof button.url === "string" && button.url ? <span className="ml-2 text-xs text-muted-foreground"><Highlighted text={button.url} /></span> : null}
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
    </div>
  )
}
