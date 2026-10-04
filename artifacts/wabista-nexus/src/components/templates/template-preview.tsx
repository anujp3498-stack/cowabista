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

/**
 * Optional resolved values (V2-05B Message Studio). These come from the
 * server's shared resolver -- the same one send preparation uses -- so
 * this component only places them; it never computes or invents a value.
 * A slot missing from `values` is shown as an explicit unresolved marker.
 */
export type ResolvedPreview = {
  values: { header: Record<string, string>; body: Record<string, string>; button: Record<string, string> }
  unresolved: string[]
  headerMedia?: { src?: string; label: string } | null
}

function Substituted({ text, values, keyFor }: { text: string; values: Record<string, string>; keyFor: (variable: string) => string }) {
  const parts = text.split(/(\{\{\s*\d+\s*\}\})/g)
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\{\{\s*(\d+)\s*\}\}$/.exec(part)
        if (!match) return <span key={index}>{part}</span>
        const value = values[match[1]!]
        return value !== undefined
          ? <span key={index} className="rounded bg-primary/10 px-0.5" data-testid={`resolved-${keyFor(match[1]!)}`}>{value}</span>
          : <span key={index} className="rounded bg-destructive/10 px-1 font-mono text-destructive" data-testid={`unresolved-${keyFor(match[1]!)}`}>{`{{${match[1]}}}`} missing</span>
      })}
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

export function TemplatePreview({ components, bodyFallback = "", emptyBodyHint, resolved, "data-testid": testId }: { components: Component[]; bodyFallback?: string; emptyBodyHint?: string; resolved?: ResolvedPreview; "data-testid"?: string }) {
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
              <p className="font-semibold">{resolved ? <Substituted text={header.text} values={resolved.values.header} keyFor={(v) => `header-${v}`} /> : <Highlighted text={header.text} />}</p>
            ) : resolved?.headerMedia?.src && headerFormat === "IMAGE" ? (
              <img src={resolved.headerMedia.src} alt={resolved.headerMedia.label} className="max-h-48 w-full rounded-md object-cover" data-testid="preview-media-header" />
            ) : resolved && resolved.unresolved.includes("header:media") ? (
              <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-destructive/50 text-xs text-destructive" data-testid="preview-media-header">
                No {headerFormat.toLowerCase()} chosen yet
              </div>
            ) : (
              <div className="flex h-20 items-center justify-center rounded-md border border-dashed text-xs uppercase tracking-wide text-muted-foreground" data-testid="preview-media-header">
                {resolved?.headerMedia ? `${headerFormat.toLowerCase()}: ${resolved.headerMedia.label}` : `${headerFormat.toLowerCase()} header`}
              </div>
            )}
          </div>
        ) : null}
        {bodyText.trim() ? (
          <p className="whitespace-pre-wrap" data-testid="preview-body">{resolved ? <Substituted text={bodyText} values={resolved.values.body} keyFor={(v) => `body-${v}`} /> : <Highlighted text={bodyText} />}</p>
        ) : (
          <p className="text-muted-foreground" data-testid="preview-body">{emptyBodyHint ?? ""}</p>
        )}
        {typeof footer?.text === "string" ? <p className="mt-3 text-xs text-muted-foreground">{footer.text}</p> : null}
        {buttonList.length ? (
          <div className="mt-3 space-y-1 border-t pt-3">
            {buttonList.map((button, index) => (
              <div key={index} className="rounded-md border bg-background px-3 py-1.5 text-center text-sm text-primary" data-testid={`preview-button-${index}`}>
                {String(button.text ?? button.type ?? "Button")}
                {typeof button.url === "string" && button.url ? (
                  <span className="ml-2 break-all text-xs text-muted-foreground">
                    {resolved
                      ? <Substituted text={button.url} values={Object.fromEntries(Object.entries(resolved.values.button).filter(([key]) => key.startsWith(`${index}:`)).map(([key, value]) => [key.split(":")[1]!, value]))} keyFor={(v) => `button-${index}-${v}`} />
                      : <Highlighted text={button.url} />}
                  </span>
                ) : null}
                {typeof button.phone_number === "string" ? <span className="ml-2 text-xs text-muted-foreground">{button.phone_number}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        {resolved
          ? resolved.unresolved.length
            ? <span className="text-destructive" data-testid="preview-unresolved-count">{resolved.unresolved.length} {resolved.unresolved.length === 1 ? "variable has" : "variables have"} no value for this recipient.</span>
            : <span data-testid="preview-unresolved-count">Every variable has a value for this recipient.</span>
          : variables.length
          ? <>Variables to fill: {[...new Set(variables)].map((name) => <code key={name} className="mr-1 rounded bg-muted px-1 font-mono">{name}</code>)}</>
          : "This template has no variables."}
      </div>
    </div>
  )
}
