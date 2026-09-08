import { createHash } from "node:crypto";

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

/** Incremental RFC-4180 parser; retains only the current field and row. */
export async function* parseCsv(chunks: AsyncIterable<Buffer | string>): AsyncGenerator<string[]> {
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;
  let pendingCr = false;
  for await (const chunk of chunks) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
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
  }
  if (pendingQuote) quoted = false;
  if (quoted) throw new Error("CSV ended inside a quoted field");
  if (field.length || row.length) {
    row.push(field);
    yield row;
  }
}