---
name: STOP suppression fencing window
description: Exact boundary of the atomic fencing between the pre-send suppression check and the actual WhatsApp provider call in the campaign send path.
---

The send path (`whatsapp-template-sender.ts`) takes a Postgres advisory lock keyed on `suppression-phone:${org}:${recipient}` and does an authoritative suppression recheck *inside* the same reservation transaction that creates the `provider_messages` row. This closes the obvious race where a STOP arrives between an early suppression check and that reservation.

However, the advisory lock is only held for the reservation transaction, not across the actual outbound provider HTTP call, which happens *after* that transaction commits. So a STOP whose webhook is processed in the narrow window after the reservation transaction commits but before the provider handoff completes could still theoretically let one message through.

**Why:** discovered auditing tracker item "close the tiny timing gap where a contact could still get one message right after texting STOP" — the existing concurrent test (`campaign-suppression.test.ts`) only proves the lock-held-during-reservation window is closed, not this narrower post-commit/pre-handoff window.

**How to apply:** if asked to fully close this race, the fix has to either extend the fencing to cover the provider call itself (e.g. re-check suppression right before the HTTP call, accepting a second recheck query) or make the provider call itself abortable/compensatable on a late STOP — a plain "hold the DB transaction longer" fix won't work because you can't hold a DB transaction open across a slow external HTTP call.
