---
name: Flex layout table overflow on mobile
description: Why a wide data table can blow out the whole page width on small viewports even though the table itself has an overflow-auto wrapper.
---

Shadcn's `Table` component wraps the `<table>` in a `div.overflow-auto`, which normally clips/scrolls internal overflow without expanding its parent. But if that wrapper sits inside an app-shell layout built from nested flex containers (e.g. `flex flex-col` > `main.flex-1` > page content), flex items default to `min-width: auto`, which means their minimum width is their content's min-content size — not 0. A wide table's intrinsic content width then propagates up as a min-width constraint on every flex-item ancestor, stretching the whole page (including headers/buttons above the table) wider than the viewport on mobile, even though nothing there looks like a table.

**Why:** Discovered while building a SaaS dashboard shell (Wabista Nexus) — page headers and buttons appeared cut off on a 390px mobile viewport, with no visible horizontal scrollbar, even though only a `<Table>` further down the page had wide content.

**How to apply:** In any flex-based app shell (sidebar + main content column), add `min-w-0` to every flex item in the chain that wraps the main content area (the flex column div and the `<main>` element, at minimum). Do this proactively whenever a data-dense page (wide tables) lives inside a flex shell layout, and verify by screenshotting a narrow mobile viewport (e.g. 390px) on at least one table-heavy page.
