---
name: Reservoir broker depth accounting
description: How broker depth relates to queued and in-flight transport work when deciding supply watermarks
---

The reservoir's broker depth is the logical count of published work that remains outstanding until its ACK is queued. It already includes deliveries adopted into the local queue and provider in-flight work, so watermark calculations should add only locally reserved, not-yet-published claims.

**Why:** Adding queued or provider-in-flight counters again makes a lane appear fuller than it is and delays demand-driven refills; subtracting broker depth on consume would instead undercount durable broker work before ACK.

**How to apply:** Preserve broker depth through consume/adoption, decrement it when a delivery is ACK-queued, and use broker depth plus reserved claims for supply watermarks. Keep queue/provider counters for transport capacity and ACK debt controls.