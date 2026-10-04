import type { TemplateDraftContent, TemplateDraftHeader, TemplateDraftButton } from "@workspace/api-client-react"

// Client-side mirror of the server's authoring rules, used for live
// preview and inline hints only. The server validates again on every save
// and submission and is the source of truth; nothing here may relax it.

export const HEADER_TEXT_MAX = 60
export const BODY_TEXT_MAX = 1024
export const FOOTER_TEXT_MAX = 60
export const BUTTON_TEXT_MAX = 25
export const MAX_BUTTONS = 10

export function emptyContent(): TemplateDraftContent {
  return { header: { kind: "none" }, body: { text: "", examples: [] }, footer: null, buttons: [] }
}

export function variableNumbers(text: string): number[] {
  const seen: number[] = []
  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const n = Number(match[1])
    if (!seen.includes(n)) seen.push(n)
  }
  return seen.sort((a, b) => a - b)
}

export function isMediaHeader(header: TemplateDraftHeader): header is TemplateDraftHeader & { kind: "image" | "video" | "document" } {
  return header.kind === "image" || header.kind === "video" || header.kind === "document"
}

/**
 * Preview components in the same shape the Meta snapshot uses, so a draft
 * and a synced template render through one preview. Media headers carry
 * no handle here: the preview shows the kind only.
 */
export function draftComponents(content: TemplateDraftContent): Record<string, unknown>[] {
  const components: Record<string, unknown>[] = []
  if (content.header.kind === "text") components.push({ type: "HEADER", format: "TEXT", text: content.header.text ?? "" })
  else if (isMediaHeader(content.header)) components.push({ type: "HEADER", format: content.header.kind.toUpperCase() })
  components.push({ type: "BODY", text: content.body.text })
  if (content.footer && content.footer.text.trim()) components.push({ type: "FOOTER", text: content.footer.text })
  if (content.buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: content.buttons.map((button: TemplateDraftButton) => {
        if (button.type === "url") return { type: "URL", text: button.text, url: button.url ?? "" }
        if (button.type === "phone") return { type: "PHONE_NUMBER", text: button.text, phone_number: button.phoneNumber ?? "" }
        return { type: "QUICK_REPLY", text: button.text }
      }),
    })
  }
  return components
}

/** Substitutes the examples into the text for the "with examples" preview. */
export function withExamples(text: string, examples: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, n: string) => {
    const example = examples[Number(n) - 1]
    return example && example.trim() ? example : match
  })
}

export function describeDraftState(state: string): string {
  switch (state) {
    case "draft": return "Not sent to Meta yet. Edit freely."
    case "submitting": return "The creation request is in flight. Content is frozen until Meta answers."
    case "submitted": return "Meta accepted the template. Its approval status comes from Meta and is refreshed on sync or on demand."
    case "failed": return "Meta refused the last submission. Fix the draft and submit again."
    case "reconcile_required": return "The last request's outcome is unknown. It is never retried: the draft stays locked (no edit, delete or resubmit) until Meta confirms whether the template exists."
    default: return state
  }
}
