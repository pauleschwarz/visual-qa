# Changelog

## 0.2.0 — 2026-09-11

### Ship gate
- `run` requires vision review for completeness. Missing key/budget/pairs/endpoint
  emits `vqa-vision-required-unavailable`, sets `coverage.vision_complete=false`,
  and keeps the run incomplete. Silent green without eyes is forbidden.
- Scroll ladder screenshots (`state_scroll_scan`) feed harness vision so mid-page
  situations are reviewed, not only top-of-page.

### Explorer
- Accessible names resolve multi-id `aria-labelledby` and sibling labels on empty
  radio/swatch controls (common rating widgets).
- Locale restore prefers storage + reload for SPA language toggles; disabled
  inventory kept for renamed controls; replay uses live control resolution.
- Layout: small-target checks only on actually visible nodes; blank-scroll uses
  viewport coverage ratio.
- Path effects / `diffSignals` improve restore-mismatch evidence.

### Demo / CI
- Demo again completes the seeded fixture as deterministic `FAIL` (explore-only;
  vision gate is for `run`). Restores CI contract.

### Docs
- README + harness document vision-required completeness and verdict table.

## 0.1.0

Initial public pre-release.
