---
name: Distributed send-limit clock
description: Why horizontally scaled send workers must couple throughput reservations and leases to one authoritative database clock.
---

Throughput reservations, job leases, and attempt accounting must be committed together, with lease and limiter timestamps derived from the database clock.

**Why:** A runtime tick can outlive its initial timestamp, and replica clocks can differ. Reusing either clock can create leases that are expired at commit or split one real provider window across different application-defined windows, allowing recovery workers to overlap sends.

**How to apply:** For any horizontally scaled sender, reserve every applicable scope (tenant route and shared provider identity), claim the exact job lease, and update attempt/queue metrics in one transaction. Roll back all reservations if any scope is full or the job claim loses a race.