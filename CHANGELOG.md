# Changelog

## 0.2.8 — 2026-09-16

### Mandatory interaction coverage
- Walk ranking prefers checkbox/radio/switch and text fields before decorative buttons so capped budgets still drive state-changing controls.
- Layout clip probe measures password fields by painted `scrollWidth` and textareas by `scrollHeight`; text inputs still use an offscreen width probe.
- Scroll occlusion treats `position: sticky` the same as `fixed`.
- Style-identity shift reports on any changed fingerprint key, not only two.
- Touch-target size uses the largest client rect among the control and its labels.
- XSS canary uses a unique id per field and removes the previous node so later probes are not silent.

## 0.2.7 — 2026-09-14

### Fail-closed harness vision coverage
- `review-apply` loads `vision/requests.json` and requires every planned request
  ID exactly once among valid accepted answers.
- Unknown, duplicate, malformed findings, skill mismatches, or missing IDs keep
  `coverage.vision_complete=false`, verdict `COVERAGE_INCOMPLETE`, and issue
  `vqa-vision-review-incomplete` with machine-readable required/answered/missing/invalid.
- Partial batches may add findings but stay incomplete until the full plan is answered.

### DESIGN.md contract + preservation critic
- `--design-contract FILE` (explicit missing/unreadable fails early).
- Auto-discovers `DESIGN.md` in the invoking project root when present; generic
  projects without one are unchanged.
- Report records `design_contract.path` + `sha256`; every harness/endpoint vision
  prompt includes the authoritative contract and preservation instructions.
- New vision skill `preservation`: defect only on contract/baseline/a11y/intent
  violations; uncertainty preserves existing UI.

### Hierarchical baselines + capture
- `--baseline-dir` resolves `<baseline>/<route-key>/<viewport>.png`, with legacy
  flat `<viewport>.png` fallback. Evidence names old/new files and route.
- `baseline-capture --url URL --out DIR [--changed-target …]` captures hierarchical
  shots from a separately running pre-change URL.
- Explore compares **every** changed-target/entry URL against its own
  hierarchical baseline (not only the first route). Missing any route keeps
  `COVERAGE_INCOMPLETE`.

### agent-run observe wrapper
- `agent-run --url URL [--baseline-url URL] [--out DIR] [--git-ref REF] [--design-contract FILE]`
- Reads `.visual-qa.yml` (`trigger` / `ignore` / `route_map`) without extra deps.
- No UI diff → explicit noop PASS. UI diff without route map → fail-closed.
- `FULL` mapping → full mode. Captures baseline from `--baseline-url` before candidate run.
- Records Git HEAD/ref/diff SHA and DESIGN SHA. Never runs/applies fixers.
- Receipt stamps `policy.max_review_fix_loops` (default 2 from `.visual-qa.yml`)
  and `fixer_applied: false`. Coding agents own the loops; visual-qa does not.

### agent-gate bindings
- When `agent_run` evidence is present, requires non-empty Git state; design
  metadata when a contract was recorded. Stale/missing/review-incomplete cannot PASS.
- Refuses `fixer_applied: true` and `review_fix_loops` above the stamped cap.
- Direct non-agent runs remain compatible.

## 0.2.6 — 2026-09-12

### Autonomous-agent evidence gate
- `agent-gate` joins a completed Visual QA report with a fresh Pi Verity receipt
  and writes a fail-closed, portable `agent-gate.json`.
- Gate is pure evidence evaluation: it never starts tools, mutates source,
  calls models, or publishes.
- Documented safe agent loop: narrow test → Verity → full Visual QA + vision →
  explicit receipt gate.

## 0.2.5 — 2026-09-12

### Release hardening
- Harness preparation now returns its `vision/` directory explicitly, matching
  run metadata without relying on a fallback path.
- npm publishes are public by default and run the full verification suite first.

## 0.2.4 — 2026-09-11

### Harness apply closes vision
- `review-apply` sets `coverage.vision_complete=true` and drops
  `vqa-vision-required-unavailable` once request ids are answered.
- Empty findings are valid ("looks clean") — no longer rejected.
- Walk bounds (`limit_reason`) still keep `complete=false`; vision can finish independently.
- Live E2E: run → batches → smart screenshot review → apply → vision_complete.

## 0.2.3 — 2026-09-11

### Harness subagent vision (default)
- `review-prepare` writes `vision/plan.md`, `vision/plan.json`, and
  `vision/batches/batch-XX.json` with absolute screenshot paths + child contract.
- Calling agent spawns one short-lived reviewer per batch (same model / smart),
  merges `{results}` into `vision/findings.json`, runs `review-apply`.
- No API key required for complete vision. Endpoint/OmniRoute remains optional CI path.
- CLI: `--batch-size N` (default 4). Env: `VQA_VISION_BATCH_SIZE`.

## 0.2.2 — 2026-09-11

### Multi-model vision (OmniRoute)
- Vision transport resolves `VQA_VISION_*` then `OPENAI_BASE_URL`/`OPENAI_API_KEY`
  (OmniRoute :20128) then `OMNIROUTE_API_KEY`.
- With a key present, `run` auto-arms a vision budget (`VQA_VISION_MAX_CALLS`,
  default 24; opt out `VQA_VISION_DISABLE=1`).
- Discovers multimodal models via `GET /models` or pin with `VQA_VISION_MODELS`.
- Jobs = (state scan + scroll ladder + action pairs) × 5 skills, round-robin
  across all available vision models.
- New **color** skill (contrast, multi-accent, neon, gray-on-gray, status colors).
- Dispatch log at `.qa/vision/dispatch.json`.

## 0.2.1 — 2026-09-11

### Direct-observer aesthetics
- Deterministic slop expands beyond gradients/glow/glass:
  fake-SaaS marketing fluff, type-family soup, chaotic type scale, irregular
  spacing rhythm, inconsistent radii, generic equal feature-card + gradient
  template chrome, centered marketing blocks with fluff.
- Vision skill prompts rewritten as harsh direct-observer critics (layout,
  readability/hierarchy, AI/template slop, system consistency), including
  scroll situations and empty/dead viewport bands.
- Higher finding budget for deterministic slop (18).

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
