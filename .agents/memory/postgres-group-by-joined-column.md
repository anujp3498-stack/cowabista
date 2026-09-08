---
name: Postgres GROUP BY functional-dependency gotcha across joins
description: A joined table's column selected ungrouped alongside GROUP BY on the primary table's PK passes Drizzle/TS but fails at runtime with a Postgres GROUP BY error.
---

Postgres only infers a selected column is functionally dependent on a `GROUP BY` column when that selected column belongs to the **same table** whose primary key is in the `GROUP BY` list. Selecting a column from a joined table (e.g. `phoneNumbers.tpsLimit`) while grouping only by the primary table's PK (`campaignRoutes.id`) is **not** recognized as dependent, even though the join makes it 1:1 in practice.

**Why:** this compiles fine in Drizzle (no TS error) and looks correct at review time, but every request to the route throws `column "..." must appear in the GROUP BY clause or be used in an aggregate function` — a runtime-only failure. It surfaced here in a monitoring/reporting endpoint that aggregated `campaign_jobs` per `campaign_routes` row while also selecting `phone_numbers.tps_limit` from the joined table.

**How to apply:** whenever a `.groupBy()` query also selects a column from a joined table (not the grouped table itself), either (a) add that joined table's own primary key to the `GROUP BY` list too, or (b) wrap the joined column in an aggregate (`max()`/`min()`). Test any new aggregate/report endpoint against a real row with a join, not just an empty-result case — the empty-result path skips the GROUP BY entirely and won't catch this.
