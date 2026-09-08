// Client-side mirror of the api-server's describeTemplate()/extractVariables()
// (artifacts/api-server/src/services/template-mapping.ts). This exists ONLY
// to preview, in the UI, which {{n}} slots a candidate template selection
// will need mapped -- before the user saves anything. The backend recomputes
// and validates the same thing from scratch on every PUT, so a mismatch here
// can never let an unmapped variable slip through; it would just show a
// stale/wrong preview until the next save. Keep this in sync with the
// backend function if template component parsing ever changes there.

export type TemplateComponent = Record<string, unknown>

export type TemplateDescriptor = {
  templateId: number
  headerKind: "none" | "text" | "image" | "video" | "document"
  requiredVariables: string[]
}

function extractVariables(text: string): string[] {
  const matches = Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), (m) => m[1]!)
  return [...new Set(matches)].sort((a, b) => Number(a) - Number(b))
}

export function describeTemplate(template: {
  id: number
  body: string
  components?: TemplateComponent[] | null
}): TemplateDescriptor {
  const components = template.components ?? []
  const header = components.find((c) => String(c.type).toUpperCase() === "HEADER")
  const rawFormat = typeof header?.format === "string" ? header.format.toLowerCase() : "none"
  const headerKind = (["text", "image", "video", "document"].includes(rawFormat) ? rawFormat : "none") as TemplateDescriptor["headerKind"]

  const requiredVariables = extractVariables(template.body).map((v) => `body:${v}`)
  if (["image", "video", "document"].includes(headerKind)) requiredVariables.push("header:media")

  for (const component of components) {
    if (String(component.type).toUpperCase() !== "BUTTONS" || !Array.isArray(component.buttons)) continue
    component.buttons.forEach((button: unknown, index: number) => {
      if (button && typeof button === "object" && "url" in button && typeof (button as { url: unknown }).url === "string") {
        extractVariables((button as { url: string }).url).forEach((v) => requiredVariables.push(`button:${index}:${v}`))
      }
    })
  }
  if (header && typeof header.text === "string") {
    extractVariables(header.text).forEach((v) => requiredVariables.push(`header:${v}`))
  }

  return { templateId: template.id, headerKind, requiredVariables }
}

export function parseRequirement(requirement: string): { component: "header" | "body" | "button"; variable: string } {
  const [component, ...rest] = requirement.split(":")
  return { component: component as "header" | "body" | "button", variable: rest.join(":") }
}

export function labelForRequirement(requirement: string): string {
  const { component, variable } = parseRequirement(requirement)
  if (component === "header" && variable === "media") return "Header media (image/video/document URL)"
  if (component === "header") return `Header text variable {{${variable}}}`
  if (component === "body") return `Body variable {{${variable}}}`
  if (component === "button") {
    const [index, varNum] = variable.split(":")
    return `Button ${Number(index) + 1} URL variable {{${varNum}}}`
  }
  return requirement
}
