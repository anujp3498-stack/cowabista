---
name: Mock WhatsApp provider has no delivery simulation
description: Why provider_messages/provider_events stay near-empty in the dev/mock environment, and what that means for analytics or dashboards built on that data.
---

`MockWhatsAppProviderClient` (artifacts/api-server/src/services/whatsapp-provider.ts) only fakes `send()` returning a deterministic message id. Nothing in the codebase automatically follows up with simulated "delivered"/"read"/"failed" webhook callbacks. `provider_messages.status` moves from "pending" to "sent" at actual send time (artifacts/api-server/src/services/whatsapp-template-sender.ts) and only advances further via a real webhook POST processed by `processWhatsAppStatus` (artifacts/api-server/src/services/whatsapp-webhook.ts), which also writes `provider_events` rows.

**Why:** discovered while building analytics endpoints that read delivered/read/failed counts from these tables — in a fresh dev org with no webhook traffic, delivery/read rates correctly show 0% even after messages are sent, which is accurate, not a bug.

**How to apply:** don't "fix" a dashboard that shows 0% delivered/read in dev by inventing simulated data — that would violate the project's no-fake-data principle. To see non-zero rates in dev/testing, either post a real webhook payload to the WhatsApp webhook endpoint, or seed `provider_messages`/`provider_events` rows directly in tests (see artifacts/api-server/test/analytics.test.ts for the pattern).
