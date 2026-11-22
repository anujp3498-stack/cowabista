/** Selection-only helpers. The server supplies eligible sender IDs using V2-04's
 * compatibility decision. Nothing here guesses eligibility from a WABA name.
 */
export type RocketTemplateOption = {
  templateId: number;
  usable: boolean;
  compatibleSenderIds: number[];
};

export function eligibleTemplateIdsForSenders(
  templates: readonly RocketTemplateOption[],
  selectedSenderIds: readonly number[],
): Set<number> {
  const senders = new Set(selectedSenderIds);
  return new Set(templates
    .filter((template) => template.usable && template.compatibleSenderIds.some((id) => senders.has(id)))
    .map((template) => template.templateId));
}

export function keepEligibleTemplateSelection(
  selectedTemplateIds: readonly number[],
  eligibleIds: ReadonlySet<number>,
): number[] {
  return selectedTemplateIds.filter((id) => eligibleIds.has(id));
}
