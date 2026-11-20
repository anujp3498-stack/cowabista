import { and, eq, exists, isNull, or, sql } from "drizzle-orm";
import { db, phoneNumbersTable, templatesTable } from "@workspace/db";

/**
 * Active management/selection lists must not leak templates whose WABA has
 * no remaining connected, unarchived number in this workspace.
 *
 * Keep template rows untouched: completed campaigns, jobs and provider
 * receipts refer to their stable ids. A number restored/reconnected later
 * makes the WABA templates visible without reconstructing history.
 *
 * Unbound *local* draft rows may remain in the generic Template Center, but
 * unbound provider-backed rows are not active WhatsApp templates.
 * This predicate is intentionally tenant-correlated and runs in SQL before
 * LIMIT, rather than trimming a cached list after pagination.
 */
export function activeTemplateVisibilityPredicate() {
  return or(
    and(
      isNull(templatesTable.wabaId),
      isNull(templatesTable.providerTemplateId),
      sql`coalesce(${templatesTable.metadata}->>'source', 'local') = 'local'`,
    ),
    exists(
      db.select({ id: phoneNumbersTable.id }).from(phoneNumbersTable).where(and(
        eq(phoneNumbersTable.organizationId, templatesTable.organizationId),
        eq(phoneNumbersTable.wabaId, templatesTable.wabaId),
        eq(phoneNumbersTable.status, "Connected"),
        eq(phoneNumbersTable.isSample, false),
        isNull(phoneNumbersTable.archivedAt),
      )),
    ),
  )!;
}
