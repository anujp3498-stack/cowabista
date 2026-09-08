---
name: WhatsApp per-number TPS ceiling must come from Meta's throughput field
description: How to determine and keep fresh a real "provider-approved" TPS cap for a WhatsApp Cloud API phone number, and the sync bug pattern that silently breaks it.
---

Meta's Cloud API has no literal "TPS" field on a phone number. The real, documented
signal is `throughput.level` (fetched as a Graph API field on the phone number):
`STANDARD` = 80 messages/sec (default for every number), `HIGH` = 1,000 messages/sec
(Meta auto-upgrades eligible numbers, no manual request). Source:
https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput

**Why:** a gate that only lets an operator raise a number's configured TPS above a
conservative default when a "provider-approved cap" is on file is a good safety
design, but it silently locks every operator out forever if nothing ever populates
that cap field. The fix is to fetch `throughput.level` during provider sync and map
it to a numeric ceiling — never let the operator-facing config field itself be the
source of truth for what's "approved".

**How to apply:** when syncing any provider-derived safety ceiling (not just TPS),
make sure the sync's `onConflictDoUpdate`/upsert path actually re-writes the
metadata column on every sync, not just on first insert — an upsert that updates
other columns but omits the metadata column means a number's cap can never change
after the first sync (e.g. an upgrade from STANDARD to HIGH would never be
reflected, and conversely a stale/corrupted value would never self-heal on re-sync).
