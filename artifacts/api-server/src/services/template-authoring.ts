import type { TemplateDraftContent } from "@workspace/db";

// V2-03B authoring rules for the Business Management API template object.
//
// Supported in this slice: MARKETING and UTILITY templates with
//   header: none | text (<= 60 chars, at most one {{1}}) | image | video |
//           document (an uploaded media example)
//   body:   required, <= 1024 chars, positional {{n}} variables each with an
//           example
//   footer: optional, <= 60 chars, no variables
//   buttons: up to 10; quick replies (<= 25 chars), URL (<= 25 char text,
//           <= 2000 char url, at most one {{1}} at the end, with an example),
//           phone (<= 25 char text, E.164 number); at most 2 URL and 1
//           phone button; quick replies must be grouped together, not
//           interleaved with other kinds.
// AUTHENTICATION templates and carousel/LTO/catalog/copy-code types have
// their own payload rules and are deliberately not offered.
//
// Reference (could not be fetched live from this environment; verify
// before production use):
//   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/
//   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components
//   https://developers.facebook.com/docs/graph-api/guides/upload/

export const SUPPORTED_CATEGORIES = ["MARKETING", "UTILITY"] as const;
export const HEADER_TEXT_MAX = 60;
export const BODY_TEXT_MAX = 1024;
export const FOOTER_TEXT_MAX = 60;
export const BUTTON_TEXT_MAX = 25;
export const BUTTON_URL_MAX = 2000;
export const MAX_BUTTONS = 10;
export const MAX_URL_BUTTONS = 2;
export const MAX_PHONE_BUTTONS = 1;
export const TEMPLATE_NAME_MAX = 512;
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]+$/;
export const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2,4})?$/;

export type DraftFieldError = { field: string; message: string };

const VARIABLE = /\{\{\s*(\d+)\s*\}\}/g;

/** Positional variables in order of first appearance, e.g. [1, 2]. */
export function variableNumbers(text: string): number[] {
  const seen: number[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    const n = Number(match[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

function sequential(numbers: number[]): boolean {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.every((n, index) => n === index + 1);
}

export function emptyDraftContent(): TemplateDraftContent {
  return { header: { kind: "none" }, body: { text: "", examples: [] }, footer: null, buttons: [] };
}

/**
 * Structural validation of what a draft may contain (always enforced) plus,
 * with `forSubmission`, the completeness Meta requires. Every error names
 * the field it belongs to; variables are scoped per component.
 */
export function validateDraft(
  draft: { name: string; language: string; category: string; content: TemplateDraftContent; wabaId: number | null },
  options: { forSubmission: boolean; mediaReady?: (mediaUploadId: number) => boolean },
): DraftFieldError[] {
  const errors: DraftFieldError[] = [];
  const { content } = draft;
  const name = draft.name.trim();
  if (!name) errors.push({ field: "name", message: "Give the template a name." });
  else if (name.length > TEMPLATE_NAME_MAX) errors.push({ field: "name", message: `Name must be at most ${TEMPLATE_NAME_MAX} characters.` });
  else if (!TEMPLATE_NAME_PATTERN.test(name)) errors.push({ field: "name", message: "Use lowercase letters, numbers and underscores only." });
  if (!LANGUAGE_PATTERN.test(draft.language)) errors.push({ field: "language", message: "Use a language code such as en_US or hi." });
  if (!(SUPPORTED_CATEGORIES as readonly string[]).includes(draft.category)) errors.push({ field: "category", message: "Choose Marketing or Utility." });
  if (options.forSubmission && draft.wabaId === null) errors.push({ field: "wabaId", message: "Choose the business account to submit through." });

  if (!content || typeof content !== "object") return [...errors, { field: "content", message: "Draft content is missing." }];

  // Header
  const header = content.header ?? { kind: "none" };
  if (header.kind === "text") {
    const text = header.text ?? "";
    if (!text.trim()) { if (options.forSubmission) errors.push({ field: "header.text", message: "Enter the header text or remove the header." }); }
    else if (text.length > HEADER_TEXT_MAX) errors.push({ field: "header.text", message: `Header must be at most ${HEADER_TEXT_MAX} characters.` });
    const vars = variableNumbers(text);
    if (vars.length > 1 || (vars.length === 1 && vars[0] !== 1)) errors.push({ field: "header.text", message: "A header can hold one variable, {{1}}." });
    if (vars.length === 1 && options.forSubmission && !(header.example ?? "").trim()) errors.push({ field: "header.example", message: "Give an example value for {{1}} in the header." });
  } else if (header.kind === "image" || header.kind === "video" || header.kind === "document") {
    if (options.forSubmission) {
      if (!header.mediaUploadId) errors.push({ field: "header.mediaUploadId", message: `Upload a ${header.kind} example for the header.` });
      else if (options.mediaReady && !options.mediaReady(header.mediaUploadId)) errors.push({ field: "header.mediaUploadId", message: "The uploaded media example is no longer available. Upload it again." });
    }
  } else if (header.kind !== "none") {
    errors.push({ field: "header.kind", message: "Unsupported header type." });
  }

  // Body
  const bodyText = content.body?.text ?? "";
  if (!bodyText.trim()) { if (options.forSubmission) errors.push({ field: "body.text", message: "Enter the message body." }); }
  else if (bodyText.length > BODY_TEXT_MAX) errors.push({ field: "body.text", message: `Body must be at most ${BODY_TEXT_MAX} characters.` });
  const bodyVars = variableNumbers(bodyText);
  if (!sequential(bodyVars)) errors.push({ field: "body.text", message: "Number body variables in order: {{1}}, {{2}}, …" });
  const examples = Array.isArray(content.body?.examples) ? content.body.examples : [];
  if (options.forSubmission) {
    bodyVars.forEach((n) => {
      if (!(examples[n - 1] ?? "").trim()) errors.push({ field: `body.examples.${n - 1}`, message: `Give an example value for {{${n}}} in the body.` });
    });
  }

  // Footer
  if (content.footer) {
    const footer = content.footer.text ?? "";
    if (footer.length > FOOTER_TEXT_MAX) errors.push({ field: "footer.text", message: `Footer must be at most ${FOOTER_TEXT_MAX} characters.` });
    if (variableNumbers(footer).length) errors.push({ field: "footer.text", message: "A footer cannot hold variables." });
    if (options.forSubmission && !footer.trim()) errors.push({ field: "footer.text", message: "Enter the footer text or remove the footer." });
  }

  // Buttons
  const buttons = Array.isArray(content.buttons) ? content.buttons : [];
  if (buttons.length > MAX_BUTTONS) errors.push({ field: "buttons", message: `At most ${MAX_BUTTONS} buttons.` });
  let urlCount = 0;
  let phoneCount = 0;
  buttons.forEach((button, index) => {
    const field = `buttons.${index}`;
    const text = button.text ?? "";
    if (!text.trim()) { if (options.forSubmission) errors.push({ field: `${field}.text`, message: "Enter the button label." }); }
    else if (text.length > BUTTON_TEXT_MAX) errors.push({ field: `${field}.text`, message: `Button labels are at most ${BUTTON_TEXT_MAX} characters.` });
    if (variableNumbers(text).length) errors.push({ field: `${field}.text`, message: "Button labels cannot hold variables." });
    if (button.type === "url") {
      urlCount += 1;
      const url = button.url ?? "";
      if (!url.trim()) { if (options.forSubmission) errors.push({ field: `${field}.url`, message: "Enter the button URL." }); }
      else {
        if (url.length > BUTTON_URL_MAX) errors.push({ field: `${field}.url`, message: `URLs are at most ${BUTTON_URL_MAX} characters.` });
        if (!/^https?:\/\//i.test(url)) errors.push({ field: `${field}.url`, message: "The URL must start with http:// or https://." });
        const vars = variableNumbers(url);
        if (vars.length > 1 || (vars.length === 1 && vars[0] !== 1)) errors.push({ field: `${field}.url`, message: "A URL button can hold one variable, {{1}}, at the end." });
        else if (vars.length === 1 && !/\{\{\s*1\s*\}\}\s*$/.test(url)) errors.push({ field: `${field}.url`, message: "The {{1}} variable must be at the end of the URL." });
        if (vars.length === 1 && options.forSubmission && !(button.example ?? "").trim()) errors.push({ field: `${field}.example`, message: "Give an example value for {{1}} in the URL." });
      }
    } else if (button.type === "phone") {
      phoneCount += 1;
      const phone = (button.phoneNumber ?? "").replace(/[\s()-]/g, "");
      if (!phone) { if (options.forSubmission) errors.push({ field: `${field}.phoneNumber`, message: "Enter the phone number." }); }
      else if (!/^\+[1-9]\d{6,14}$/.test(phone)) errors.push({ field: `${field}.phoneNumber`, message: "Use the full international number, e.g. +15550000001." });
    } else if (button.type !== "quick_reply") {
      errors.push({ field: `${field}.type`, message: "Unsupported button type." });
    }
  });
  if (urlCount > MAX_URL_BUTTONS) errors.push({ field: "buttons", message: `At most ${MAX_URL_BUTTONS} URL buttons.` });
  if (phoneCount > MAX_PHONE_BUTTONS) errors.push({ field: "buttons", message: `At most ${MAX_PHONE_BUTTONS} phone button.` });
  // Quick replies must be grouped: once a non-quick-reply follows a quick
  // reply, no further quick reply may appear (and vice versa).
  const kinds = buttons.map((button) => (button.type === "quick_reply" ? "q" : "o")).join("");
  if (/q+o+q|o+q+o/.test(kinds)) errors.push({ field: "buttons", message: "Keep quick replies together, before or after the other buttons." });

  return errors;
}

/**
 * Exact provider request body for POST /{waba}/message_templates. Media
 * headers reference the stored upload's provider handle, supplied by the
 * caller after it verified the upload belongs to this organization and
 * business account. Never contains a token.
 */
export function buildTemplateCreatePayload(
  draft: { name: string; language: string; category: string; content: TemplateDraftContent },
  mediaHandle?: string,
): Record<string, unknown> {
  const components: Record<string, unknown>[] = [];
  const { content } = draft;
  if (content.header.kind === "text") {
    const text = content.header.text ?? "";
    const component: Record<string, unknown> = { type: "HEADER", format: "TEXT", text };
    if (variableNumbers(text).length) component.example = { header_text: [content.header.example ?? ""] };
    components.push(component);
  } else if (content.header.kind !== "none") {
    components.push({ type: "HEADER", format: content.header.kind.toUpperCase(), example: { header_handle: [mediaHandle ?? ""] } });
  }
  const bodyText = content.body.text;
  const body: Record<string, unknown> = { type: "BODY", text: bodyText };
  const bodyVars = variableNumbers(bodyText);
  if (bodyVars.length) body.example = { body_text: [bodyVars.sort((a, b) => a - b).map((n) => content.body.examples[n - 1] ?? "")] };
  components.push(body);
  if (content.footer && content.footer.text.trim()) components.push({ type: "FOOTER", text: content.footer.text });
  if (content.buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: content.buttons.map((button) => {
        if (button.type === "quick_reply") return { type: "QUICK_REPLY", text: button.text };
        if (button.type === "phone") return { type: "PHONE_NUMBER", text: button.text, phone_number: button.phoneNumber.replace(/[\s()-]/g, "") };
        const url: Record<string, unknown> = { type: "URL", text: button.text, url: button.url };
        if (variableNumbers(button.url).length) url.example = [button.example ?? ""];
        return url;
      }),
    });
  }
  return { name: draft.name, language: draft.language, category: draft.category, components };
}

/** The same component shape the preview and mapping helpers understand, for a draft. */
export function draftPreviewComponents(content: TemplateDraftContent): Record<string, unknown>[] {
  return buildTemplateCreatePayload({ name: "preview", language: "en_US", category: "MARKETING", content }, "").components as Record<string, unknown>[];
}

/** Evidence check for reconciliation: does a provider template match what this attempt submitted? */
export function templateMatchesPayload(template: { name: string; language: string; category?: string; components?: Record<string, unknown>[] }, payload: Record<string, unknown>): boolean {
  if (template.name !== payload.name || template.language !== payload.language) return false;
  const submitted = (payload.components as Record<string, unknown>[]) ?? [];
  const submittedBody = submitted.find((c) => String(c.type).toUpperCase() === "BODY")?.text;
  const providerBody = (template.components ?? []).find((c) => String(c.type).toUpperCase() === "BODY")?.text;
  if (typeof submittedBody === "string" && typeof providerBody === "string" && submittedBody.trim() !== providerBody.trim()) return false;
  const submittedButtons = (submitted.find((c) => String(c.type).toUpperCase() === "BUTTONS")?.buttons as unknown[] | undefined)?.length ?? 0;
  const providerButtons = ((template.components ?? []).find((c) => String(c.type).toUpperCase() === "BUTTONS")?.buttons as unknown[] | undefined)?.length ?? 0;
  return submittedButtons === providerButtons;
}
