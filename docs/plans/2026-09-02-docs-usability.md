# Plan: visual-qa docs & usability (2026-09-02)

Status: implemented in this pass (docs slice). npm publish / homepage remain product decisions.

## Problem

README is short and punchy but undersells the full CLI surface (`explore`, `intent`, `review-prepare`/`apply`, modes, bounds). No badges, no install-from-source path, no "how it differs from Playwright/Cypress/pi-verity". Safety is good; first-run mental model for agents vs humans is thin.

## Goals

1. Demo-first remains the on-ramp.
2. Full command map + exit codes on the README (not only harness.md).
3. Clear split: deterministic core vs optional vision/harness review.
4. Position vs classic E2E and vs pi-verity.
5. CONTRIBUTING + badges + docs index.

## Non-goals

- Changing CLI flags or verdict policy.
- Adding a web dashboard.
- Guaranteeing npm global install works if package unpublished — document source install.

## Gaps found (audit)

| Gap | Severity | Fix now? |
| --- | --- | --- |
| No CI/license badges | med | yes |
| Commands incomplete on README | high | yes |
| Exit codes only in harness.md | high | yes — promote |
| No "vs Playwright / vs pi-verity" | med | yes |
| No bounds/mode cheat sheet | med | yes |
| No CONTRIBUTING / source install | med | yes |
| npm publish status unclear | high | verify; document both paths |
| No docs/README index | low | yes |

## Implementation slices

### Slice A — README expansion (this pass)

Acceptance:

- [x] Badges (CI if present, license MIT)
- [x] Problem → demo → own app → verdicts
- [x] Commands table matching `visual-qa --help`
- [x] Exit codes 0/1/2 (+ demo exception)
- [x] Modes, bounds, safety, agent loop summary
- [x] Related tools (pi-verity)
- [x] Dev / verify from source

### Slice B — docs polish (this pass)

Acceptance:

- [x] docs/README.md pointing at harness.md + schemas
- [x] CONTRIBUTING.md minimal

### Slice C — later

- Confirm/publish npm `@pauleschwarz/visual-qa`
- Asciinema of `visual-qa demo`
- GitHub Action reusable workflow example
- `--help` and README flag parity check in CI

## Risks

- Documenting npm global install if package missing → always include git/source fallback.
- "No human in the loop" overclaim — keep: blocks ship on coverage/verdict; humans still own product judgment.

## Verify

- [x] Flag names match `bin/visual-qa.mjs` usage()
- [x] Internal links exist (scripted)
- [x] npm 404 documented; Git install path first
- [x] Exit codes + full command map on README
- [x] CONTRIBUTING.md + docs/README.md added
