export type TemplateDescriptor = {
  id: number;
  body: string;
  components: Record<string, unknown>[];
};

export type TemplateMappingInput = {
  templateId: number;
  component: "header" | "body" | "button";
  variable: string;
  source: "csv" | "static";
  sourceValue: string;
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