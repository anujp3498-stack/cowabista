export type TemplateDescriptor = {
  id: number;
  body: string;
  components: Record<string, unknown>[];
};

export type TemplateMappingInput = {
  templateId: number;
  component: "header" | "body" | "button";
  variable: string;
  // "media_asset" (V2-05B) is valid only for header:media and references a
  // campaign media asset (mediaAssetId; sourceValue holds the same id).
  source: "csv" | "static" | "media_asset";
  sourceValue: string;
  mediaAssetId?: number | null;
  // Optional CSV-sourced mappings fall back to `fallbackValue` when the row's
  // value is missing/blank instead of failing the job. Static mappings and
  // required mappings ignore these fields.
  optional?: boolean;
  fallbackValue?: string | null;
};

export function extractVariables(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), (match) => match[1]))]
    .sort((a, b) => Number(a) - Number(b));
}

export function describeTemplate(template: TemplateDescriptor) {
  const header = template.components.find((component) => String(component.type).toUpperCase() === "HEADER");
  const rawFormat = typeof header?.format === "string" ? header.format.toLowerCase() : "none";
  const headerKind = ["text", "image", "video", "document"].includes(rawFormat) ? rawFormat : "none";
  const requiredVariables = extractVariables(template.body).map((variable) => `body:${variable}`);
  if (["image", "video", "document"].includes(headerKind)) requiredVariables.push("header:media");
  for (const component of template.components) {
    if (String(component.type).toUpperCase() !== "BUTTONS" || !Array.isArray(component.buttons)) continue;
    component.buttons.forEach((button, index) => {
      if (button && typeof button === "object" && "url" in button && typeof button.url === "string") {
        extractVariables(button.url).forEach((variable) => requiredVariables.push(`button:${index}:${variable}`));
      }
    });
  }
  if (header && typeof header.text === "string") {
    extractVariables(header.text).forEach((variable) => requiredVariables.push(`header:${variable}`));
  }
  return { templateId: template.id, headerKind, requiredVariables };
}

export function expandSharedMediaMapping(
  descriptors: ReturnType<typeof describeTemplate>[],
  mappings: TemplateMappingInput[],
): TemplateMappingInput[] {
  const mediaDescriptors = descriptors.filter((descriptor) =>
    ["image", "video", "document"].includes(descriptor.headerKind));
  const kinds = new Set(mediaDescriptors.map((descriptor) => descriptor.headerKind));
  if (mediaDescriptors.length < 2 || kinds.size !== 1) return mappings;

  const supplied = mappings.filter((mapping) =>
    mapping.component === "header" &&
    mapping.variable === "media" &&
    mediaDescriptors.some((descriptor) => descriptor.templateId === mapping.templateId));
  if (!supplied.length) return mappings;
  const values = new Set(supplied.map((mapping) => `${mapping.source}\0${mapping.sourceValue}`));
  if (values.size > 1) {
    throw new Error("Compatible media templates must use one shared header media mapping");
  }
  const shared = supplied[0]!;
  const mappedTemplateIds = new Set(supplied.map((mapping) => mapping.templateId));
  return [
    ...mappings,
    ...mediaDescriptors
      .filter((descriptor) => !mappedTemplateIds.has(descriptor.templateId))
      .map((descriptor) => ({
        templateId: descriptor.templateId,
        component: "header" as const,
        variable: "media",
        source: shared.source,
        sourceValue: shared.sourceValue,
        ...(shared.optional !== undefined ? { optional: shared.optional } : {}),
        ...(shared.fallbackValue !== undefined ? { fallbackValue: shared.fallbackValue } : {}),
      })),
  ];
}

/**
 * Generalizes `expandSharedMediaMapping` to every positional requirement a
 * template can have: the shared image/video/document header (handled above),
 * positional body variables (`body:N`), and dynamic button variables
 * (`button:idx:N`). A single supplied mapping for one of these keys is
 * expanded only to the other selected templates that require that exact
 * same key -- a template requiring `body:2` never inherits a mapping
 * supplied for `body:1`. Templates that disagree on the value to share for
 * the same key throw, same as the media-header case.
 */
export function expandCompatibleMappings(
  descriptors: ReturnType<typeof describeTemplate>[],
  mappings: TemplateMappingInput[],
): TemplateMappingInput[] {
  let result = expandSharedMediaMapping(descriptors, mappings);

  const requirementKeys = new Set<string>();
  for (const descriptor of descriptors) {
    for (const requirement of descriptor.requiredVariables) {
      if (requirement === "header:media") continue; // already handled above
      requirementKeys.add(requirement);
    }
  }

  for (const requirement of requirementKeys) {
    const [component, ...rest] = requirement.split(":");
    const variable = rest.join(":");
    const applicable = descriptors.filter((descriptor) => descriptor.requiredVariables.includes(requirement));
    if (applicable.length < 2) continue;
    const applicableIds = new Set(applicable.map((descriptor) => descriptor.templateId));
    const supplied = result.filter((mapping) =>
      mapping.component === component &&
      mapping.variable === variable &&
      applicableIds.has(mapping.templateId));
    if (!supplied.length) continue;
    const values = new Set(supplied.map((mapping) =>
      `${mapping.source}\0${mapping.sourceValue}\0${mapping.optional ?? false}\0${mapping.fallbackValue ?? ""}`));
    if (values.size > 1) {
      throw new Error(`Compatible templates must use one shared mapping for ${requirement}`);
    }
    const shared = supplied[0]!;
    const mappedTemplateIds = new Set(supplied.map((mapping) => mapping.templateId));
    result = [
      ...result,
      ...applicable
        .filter((descriptor) => !mappedTemplateIds.has(descriptor.templateId))
        .map((descriptor) => ({
          templateId: descriptor.templateId,
          component: component as TemplateMappingInput["component"],
          variable,
          source: shared.source,
          sourceValue: shared.sourceValue,
          ...(shared.optional !== undefined ? { optional: shared.optional } : {}),
          ...(shared.fallbackValue !== undefined ? { fallbackValue: shared.fallbackValue } : {}),
        })),
    ];
  }

  return result;
}

/**
 * V2-05B shared defaults (authoring convenience, never a constraint).
 * Templates may now carry different mappings for the same slot; an explicit
 * per-template mapping always wins. Only a template with NO mapping for a
 * slot inherits one, and only when every template that does map that slot
 * agrees on it (otherwise nothing is inherited and readiness reports the
 * gap). The result is persisted as explicit rows, so every template's final
 * mapping is deterministic. Unlike expandCompatibleMappings (kept for its
 * existing callers), this never throws on disagreement.
 */
export function applySharedDefaults(
  descriptors: ReturnType<typeof describeTemplate>[],
  mappings: TemplateMappingInput[],
): TemplateMappingInput[] {
  const result = [...mappings];
  const keys = new Set(descriptors.flatMap((descriptor) => descriptor.requiredVariables));
  for (const requirement of keys) {
    const [component, ...rest] = requirement.split(":");
    const variable = rest.join(":");
    const applicable = descriptors.filter((descriptor) => descriptor.requiredVariables.includes(requirement));
    if (applicable.length < 2) continue;
    // A media header default only spreads to templates of the same kind.
    const groups = requirement === "header:media"
      ? [...new Set(applicable.map((d) => d.headerKind))].map((kind) => applicable.filter((d) => d.headerKind === kind))
      : [applicable];
    for (const group of groups) {
      const ids = new Set(group.map((descriptor) => descriptor.templateId));
      const supplied = result.filter((mapping) => mapping.component === component && mapping.variable === variable && ids.has(mapping.templateId));
      if (!supplied.length) continue;
      const signature = (m: TemplateMappingInput) => `${m.source}\0${m.sourceValue}\0${m.mediaAssetId ?? ""}\0${m.optional ?? false}\0${m.fallbackValue ?? ""}`;
      if (new Set(supplied.map(signature)).size > 1) continue;
      const shared = supplied[0]!;
      const mapped = new Set(supplied.map((mapping) => mapping.templateId));
      for (const descriptor of group) {
        if (mapped.has(descriptor.templateId)) continue;
        result.push({ ...shared, templateId: descriptor.templateId });
      }
    }
  }
  return result;
}

/** Business-facing label for a requirement key (no internal ids). */
export function requirementLabel(requirement: string, headerKind: string): string {
  const [component, ...rest] = requirement.split(":");
  if (requirement === "header:media") return `Header ${headerKind}`;
  if (component === "button") {
    const [index, variable] = rest;
    return `Button ${Number(index) + 1} link {{${variable}}}`;
  }
  return `${component === "header" ? "Header" : "Body"} {{${rest.join(":")}}}`;
}
