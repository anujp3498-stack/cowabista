import { createHash } from "node:crypto";

// V2-378: country metadata handles international numbers with AND without '+';
// never treat a string of digits as a national number unconditionally.
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/max';

// Compute once, not per CSV row (imports can contain millions of contacts).
const COUNTRY_CALLING_CODES = new Set<string>(getCountries().map((country) => getCountryCallingCode(country)));

function validInternationalNumber(value: string): string | null {
  // libphonenumber-js/max applies country-specific numbering plans.
  try {
    const parsed = parsePhoneNumberFromString(value);
    return parsed?.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

// Preserve the original E.164 compatibility for existing non-CSV workflows.
// CSV imports use normalizeImportPhone() with strict country metadata.
export function normalizePhone(raw: string, defaultCountryCode?: string): { value?: string; error?: string } {
  let value = raw.trim().replace(/[^\d+]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (!value.startsWith("+")) {
    const country = defaultCountryCode?.replace(/\D/g, "");
    if (!country) return { error: "Missing country code" };
    value = `+${country}${value.replace(/^0+/, "")}`;
  }
  const digits = value.slice(1);
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { error: "Invalid E.164 phone number" };
  return { value: `+${digits}` };
}

export function normalizeImportPhone(raw: string, defaultCountryCode?: string): { value?: string; error?: string } {
  const compact = raw.trim().replace(/[^\d+]/g, '');
  if (!compact) return { error: 'Missing phone number' };
  const explicit = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (!/^\+?\d+$/.test(explicit)) return { error: 'Invalid phone-number characters' };

  if (explicit.startsWith('+')) {
    const parsed = validInternationalNumber(explicit);
    return parsed ? { value: parsed } : { error: 'Invalid international phone number (needs review)' };
  }

  // A bare international number is common in uploaded CSVs: 9184... / 5511...
  const alreadyInternational = validInternationalNumber(`+${explicit}`);
  const configured = defaultCountryCode?.replace(/\D/g, '') ?? '';
  if (configured && !COUNTRY_CALLING_CODES.has(configured)) {
    return { error: 'Invalid default country calling code' };
  }

  const choices = new Set<string>();
  if (alreadyInternational) choices.add(alreadyInternational);
  if (configured) {
    // Some countries use a trunk prefix 0 (UK, Brazil etc.); others such as
    // Italy preserve it. Validate both representations instead of guessing.
    const nationalChoices = new Set([explicit, explicit.replace(/^0+/, '')]);
    for (const national of nationalChoices) {
      if (!national) continue;
      const parsed = validInternationalNumber(`+${configured}${national}`);
      if (parsed) choices.add(parsed);
    }
  }

  if (choices.size === 1) return { value: [...choices][0] };
  if (choices.size > 1) {
    return { error: 'Needs review: number is valid as more than one country/format; provide +country code' };
  }
  return { error: configured
    ? 'Invalid or ambiguous number for selected/default country (needs review)'
    : 'Missing or invalid country code; select a default country or use +country code' };
}

export function stableContactKey(campaignId: number, normalizedPhone: string): string {
  return createHash("sha256").update(`${campaignId}:${normalizedPhone}`).digest("hex");
}

export function partitionFor(value: string, partitions: number): number {
  const hash = createHash("sha256").update(value).digest();
  return hash.readUInt32BE(0) % Math.max(1, partitions);
}

export function assignRoute(partition: number, routeIds: number[]): number | undefined {
  return routeIds.length ? routeIds[partition % routeIds.length] : undefined;
}

/** RFC-4180 field escaping for CSV export (quotes a field only when needed). */
export function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvRow(values: string[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}

/**
 * Incremental RFC-4180 parser; retains only the current field and row.
 *
 * Buffers are decoded with ONE streaming TextDecoder across chunks, so a
 * multi-byte UTF-8 character split between two chunks is reassembled
 * instead of being decoded as two replacement characters (which corrupted
 * names and, when the split fell inside a phone cell, the phone itself).
 * A leading UTF-8 BOM is dropped so the first header never carries it.
 */
export async function* parseCsv(chunks: AsyncIterable<Buffer | string>): AsyncGenerator<string[]> {
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;
  let pendingCr = false;
  let atStart = true;
  const decoder = new TextDecoder("utf-8");
  const consume = function* (text: string): Generator<string[]> {
    if (atStart && text.length) {
      atStart = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    for (const char of text) {
      if (pendingCr) {
        pendingCr = false;
        if (char === "\n") continue;
      }
      if (quoted) {
        if (pendingQuote) {
          pendingQuote = false;
          if (char === '"') {
            field += '"';
            continue;
          }
          quoted = false;
        } else if (char === '"') {
          pendingQuote = true;
          continue;
        } else {
          field += char;
          continue;
        }
      }
      if (char === '"') quoted = true;
      else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        row.push(field);
        yield row;
        field = "";
        row = [];
        pendingCr = char === "\r";
      } else field += char;
    }
  };
  for await (const chunk of chunks) {
    const text = Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : chunk;
    yield* consume(text);
  }
  yield* consume(decoder.decode());
  if (pendingQuote) quoted = false;
  if (quoted) throw new CsvSyntaxError("CSV ended inside a quoted field");
  if (field.length || row.length) {
    row.push(field);
    yield row;
  }
}

/** The body is not a CSV document this parser can finish (as opposed to a bounded prefix cut short). */
export class CsvSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvSyntaxError";
  }
}

/**
 * Turns a raw header row into the ordered column names an import keys each
 * row by. `Object.fromEntries` on raw headers silently dropped every
 * repeated header's earlier column and merged all empty headers into one
 * "" key; here an empty header becomes `column_N` (its 1-based position)
 * and a repeated header gets a `_2`, `_3`... suffix (further suffixed if
 * that name is itself taken), so every CSV column survives with a unique
 * key, deterministically, and sniff and import always agree.
 */
export function normalizeHeaders(values: string[]): { columns: string[]; warnings: string[] } {
  const columns: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  for (const [index, raw] of values.entries()) {
    const trimmed = raw.trim();
    let name = trimmed;
    if (!name) {
      name = `column_${index + 1}`;
      warnings.push(`Column ${index + 1} has an empty header; it is available as "${name}"`);
    }
    if (taken.has(name)) {
      const base = name;
      let n = (seen.get(base) ?? 1) + 1;
      while (taken.has(`${base}_${n}`)) n++;
      seen.set(base, n);
      name = `${base}_${n}`;
      warnings.push(`Column ${index + 1} repeats the header "${base}"; it is available as "${name}"`);
    }
    taken.add(name);
    columns.push(name);
  }
  return { columns, warnings };
}

/** Header names that usually hold the recipient number (sniff suggestion only; the user decides). */
export function looksLikePhoneHeader(column: string): boolean {
  return /phone|mobile|whatsapp|msisdn|cell|tel\b|telephone|number/i.test(column);
}

/** A sampled cell that plausibly is a phone number (digits with common separators, 7+ digits). */
export function looksLikePhoneValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 16;
}

/** True only when an input is recognizably international; bare 91... and 55... are supported. */
export function isInternationalPhoneValue(value: string): boolean {
  const compact = value.trim().replace(/[^\d+]/g, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (!/^\+?\d+$/.test(international)) return false;
  return Boolean(validInternationalNumber(
    international.startsWith('+') ? international : `+${international}`,
  ));
}
