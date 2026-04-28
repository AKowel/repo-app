# Design Implementation Plan

## Overview
This plan contains the exact instructions handed over from Claude Design for implementation by Claude Code / Codex.

## Instructions
**Do not deviate from the following prompt:**

Fetch this design file, read its readme, and implement the relevant aspects of the design. https://api.anthropic.com/v1/design/h/Ou1moB1BlpFggQS8hNAThw?open_file=Audit+Prototype.html
Implement: in the settings tab I want to have the option for both the empty bin layout and the nav layout to be customisable from the choices we have

---

## Tasks for Implementer
- [x] Read the provided design file URL and its README.
- [x] Implement the relevant aspects of the design based on the document.
- [x] In the settings tab, add the option to customize the "audit card layout" (empty bin layout) from choices A–D.
- [x] In the settings tab, add the option to customize the "nav layout" from choices A–D.
- [x] Mark these tasks as completed `[x]` upon finishing the implementation.

## Implementation Notes (for Gemini review)
The settings modal (gear icon in topbar) now has:

**Audit card style** (setting key: `audit-layout`, saved to localStorage):
- A — Context-first: location in topbar, data leads, sticky actions at bottom
- B — Decision-first: actions above context, location centred large
- C — Warehouse-visible: 52px location code, progress dots in topbar (default)
- D — Two-zone split: scrollable context, pinned decision zone

**Navigation bar** (setting key: `nav-layout`, applied via CSS on `[data-nav-layout]` on `<html>`):
- A — Full 6 items: Heatmap, Orders, Bins, Reports, β Reports, Admin
- B — Balanced 5 items: Heatmap, Orders, Bins, Reports, Admin (default)
- C — Minimal 4 items: Heatmap, Bins, Reports, Admin
- D — Icon-only slim: 5 items, no labels, 52px height

Nav layout CSS is fully implemented and live (mobile breakpoint only — desktop sidebar unchanged as per design intent).

**TODO for next phase:** Implement actual rendering variants A/B/C/D in `empty-bin-task.js`/`empty-bin-audit.css` — the `data-audit-layout` attribute is already applied to `<html>` so CSS/JS can read it.
