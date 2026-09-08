---
name: Streaming CSV import row/blank-line semantics
description: What rowsProcessed counts and how a trailing blank line is parsed, so a row-count mismatch isn't mistaken for a bug (or vice versa).
---

Wabista Nexus's streaming CSV contact import (`POST .../campaigns/:id/imports`) counts the header line as row 1. `rowsProcessed` in the returned/session-polled `ContactImportSession` is therefore always `1 + <data row count>`, while `validRows + invalidRows + duplicateRows + suppressedRows` sums to just the data rows. Seeing `rowsProcessed` one higher than the data-row count is correct, not a bug.

Separately, the incremental RFC-4180 parser (`parseCsv` in `contact-processing.ts`) yields a row on every newline unconditionally, including a genuinely blank line -- so a file with a real trailing blank line (e.g. `"...last row\n\n"`, not just a normal single trailing `"\n"`) produces one extra phantom empty-data row that gets classified as `Invalid` (empty phone). A single ordinary trailing newline does not trigger this; only an actual blank line does.

**Why:** an e2e test flagged a "row count mismatch" that turned out to be exactly the header-counting behavior above, confirmed via direct handler reproduction (`rowsProcessed=5` for 4 real data rows + header, buckets summing to 4). No fix was needed. The blank-line phantom-row parsing gap is real but was not hit in that run.

**How to apply:** when a future row-count assertion looks off by one, check whether the discrepancy is just the header row before assuming a backend bug. If someone reports rejected/invalid rows they didn't expect, check the uploaded file for a genuine trailing blank line before assuming provider/validation logic is wrong.
