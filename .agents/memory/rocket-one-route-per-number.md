---
name: Rocket route matrix keeps one route per number
description: Why the current Rocket setup assigns one template route to each selected phone number instead of creating a number-template Cartesian product.
---

Keep one campaign route per selected phone number and rotate the selected templates across those routes.

**Why:** The runtime enforces a configured TPS budget per route and a separate provider-approved ceiling per phone. Creating one route for every number-template combination would multiply a user's selected per-number TPS whenever a number had several template routes. A single route per number keeps aggregate configured TPS equal to the sum of the number-level choices.

**How to apply:** When changing Rocket setup or allocation, do not create a Cartesian product of numbers and templates under the current rate-limit model. To let every number send every template, first introduce a campaign-number shared TPS budget and make template choice independent of route choice.