# visual-qa

**Bounded browser QA for web apps:** explores a running app like a user,
reports findings with portable evidence, applies a small mechanical fix
whitelist when asked, and fails the ship gate when coverage or verdict is
not `PASS`.

Runs unattended. You still own the verdict and product judgment.

[![CI](https://github.com/pauleschwarz/visual-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/pauleschwarz/visual-qa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0f766e.svg)](LICENSE)

Status: **v0.2.12**. Not on npm yet — install from Git. **Chromium
only.** Node >= 20. macOS/Linux tested; Windows untested. CLI flags may change
before 1.0. Always run `npx playwright install chromium` once per machine.

## Why not "just Playwright"?

Playwright is the execution kernel. visual-qa is the bounded walk + verdict +
evidence docket on top:

| | Playwright scripts | visual-qa |
| --- | --- | --- |
| You write | Selectors + assertions | Bounds + optional intent |
| Exploration | Paths you scripted | Bounded walk of the running app |
| Output | Pass/fail you defined | Findings + **verdict** + evidence dir |
| Autofix | You | Whitelisted mechanical fixes only (title/lang/contrast), proven |
| CI posture | Your suite | `junit`/`json` + non-zero on non-`PASS` |

Chromium-only today — not multi-browser parity with raw Playwright.

**Known limits:** no authenticated areas — the explorer fills placeholder
test values, never real credentials, so login-gated pages are out of reach
(on purpose: wrong logins on a real app are mutating actions). Hover and
edge-input probes (empty / hostile / overlong) run by default; no
drag/multi-tab yet. Nothing here renders a PASS for you — you own the
verdict.

**vs [pi-verity](https://github.com/pauleschwarz/pi-verity):** Verity proves
*repository* evidence after agent edits (tests, types). **visual-qa** proves
what a **browser** can observe on a running app. Use both.

## Install (from Git)

```sh
git clone https://github.com/pauleschwarz/visual-qa.git
cd visual-qa
npm ci
npx playwright install chromium
npm link          # puts `visual-qa` on your PATH
visual-qa demo    # ~1 min on Apple Silicon; seeded defects → expect FAIL
```

The demo is intentionally broken (overflow, crashing handler, placeholder
copy). A healthy first run ends with verdict **`FAIL`**, complete coverage of
the fixture, and `report.html` full of evidence — not a green lie and not
`COVERAGE_INCOMPLETE`.

Then point it at your app:

```sh
visual-qa run --url http://127.0.0.1:3000 --out .qa
open .qa/report.html   # portable inspection docket; no server required
```

Deterministic and offline by default. Full default walk: 40 states, 160
actions, 15 minutes. Learn with
`--max-states 8 --max-actions 24 --max-runtime-ms 60000`.

- `--format junit` → CI
- **Vision is required for a complete `run`.** Without a vision endpoint or a
  finished harness `review-apply`, the report stays `COVERAGE_INCOMPLETE` and
  emits finding `vqa-vision-required-unavailable`. Silent green without eyes is
  forbidden. `demo` / bare `explore` stay deterministic-only.
- `review-prepare` / `review-apply` → **default**: spawn short-lived smart
  subagents per batch (open → vision → close); no API key
- `--max-agent-calls N` → built-in multi-model vision (`OPENAI_*` / OmniRoute or `VQA_VISION_*`)
- `--autofix verified --fix-dir ./app` → prove title/lang/contrast only
- `--intent 'ändere die Farbe von "Add item" auf grün'` → verified visual
  change (DE or EN)

## When not to use this

- You need multi-browser matrix (Firefox/WebKit) or device lab coverage.
- The app is behind auth and you have not supplied a session yet (v0.1 walks
  the public shell only).
- You want a replacement for unit/integration tests — this is a ship-gate
  on the running UI, not a test framework.
- Production traffic or real customer data (use `--isolated` only on safe
  fixtures).

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `PASS` | Explored completely, zero blocking findings, **and** vision review completed |
| `FAIL` | Findings exist |
| `COVERAGE_INCOMPLETE` | Bounded budget stopped the walk **or** vision review missing — **never** a pass |

`UNPROVEN` is emitted only by `visual-qa agent-gate` when joined Visual QA and
Verity evidence cannot prove a ship gate pass.

## Exit codes

| Code | When |
| --- | --- |
| `0` | Verdict `PASS` (exception: `visual-qa demo` exits `0` even with findings — fixture is defective on purpose) |
| `1` | Run finished; verdict is not `PASS` (findings or incomplete coverage) |
| `2` | Blocked (bad args, unreachable URL, refused mode) |

Every run writes three views: `report.html` for people, `report.md` for review,
and `report.json` for machines. Summarize an out-dir later with:

```sh
visual-qa report .qa --json
```

## Commands

```text
visual-qa demo [--out DIR] [bounds]
visual-qa run --url URL [--out DIR] [--isolated] [--autofix verified] [--fix-dir DIR]
              [--intent "…"] [--max-agent-calls N] [--mode off|changed|full] [bounds]
              [--no-prepare-review] [--no-edge-input-probes] [--design-contract FILE]
visual-qa explore --url URL [--out DIR] [bounds]     # deterministic core only
visual-qa report <DIR> [--json]                      # agent-friendly summary
visual-qa intent --intent "…" --fix-dir DIR [--json]  # catalog dry-run, no browser
visual-qa review-prepare <DIR> [--max-pairs N]       # export vision tasks for your model
visual-qa review-apply <DIR> <findings.json>         # apply findings (fail-closed full-ID coverage)
visual-qa baseline capture|compare|diff …            # see "Baselines" below
visual-qa agent-run --url URL [--baseline-url URL] [--out DIR] [--git-ref REF]
visual-qa agent-gate <QA-DIR> <verity.json> [--json] # fail-closed Visual QA + Verity receipt
```

**Output (run/explore):** `--format human|json|junit`, `--out-file FILE` (junit).

**Mode:** `--mode off|changed|full` · `--changed-target URL` (repeatable;
required for `changed`) · `--baseline-dir DIR` (`<route>/<viewport>.png` or
legacy flat) · `--design-contract FILE` (or auto `DESIGN.md`) ·
`--allow-destructive` (only with `--isolated`) · `--threshold-pct N` ·
`--pixel-threshold N` (baseline tolerance, see "Baselines") ·
`--internal-scrollers-as-finding`.

**Review defaults (`run`):** auto-exports harness vision tasks after the walk
(`--no-prepare-review` to skip) · edge input probes on text fields
(`--no-edge-input-probes` to skip). `review-apply` stays incomplete until every
planned request ID has one valid answer.

**Bounds:** `--max-states N` · `--max-depth N` · `--max-actions N` ·
`--max-actions-per-state N` · `--max-runtime-ms N`.

Full agent contract, including a fail-closed Visual QA + Pi Verity receipt
join: [`docs/harness.md`](docs/harness.md). Machine contract
(verdict policy, intent catalog, autofix whitelist):
[`schemas/intent-catalog.json`](schemas/intent-catalog.json).

## Baselines

Catch every unintended shift when you rework a UI — including app shells with their own
scroll areas — without false alarms. Capture a baseline of the current state, change code,
compare.

```bash
# 1. before the change: calm screenshots of every route at every viewport
visual-qa baseline capture --url http://127.0.0.1:3000 --out .qa-baseline \
  --route / --route /pricing --viewport mobile=390x844 --viewport desktop=1440x900

# 2. after the change: capture again under the same conditions, diff, report
visual-qa baseline compare --url http://127.0.0.1:3000 --baseline .qa-baseline
#   → .qa-baseline-compare/report.md, report.json, diff/*.png   (exit 1 on any change)

# two folders you already have (CI, tests) — no browser
visual-qa baseline diff .qa-baseline .qa-baseline-compare --threshold-pct 0.001
```

**What is captured** per route × viewport (`<out>/<route>/<viewport>[.part].png`):

| Part | Image |
| --- | --- |
| `top` | the first view, as a visitor sees it |
| `page` | the whole document — only when the page scrolls |
| `scroller-<n>` | every inner scroll area, shown whole (DOM order). The area and its parents are stretched, fixed/sticky chrome elsewhere (header, rail, composer, cookie banner) is hidden so it cannot cover content, and everything is put back afterwards. A scrolling `<body>` counts when `<html>` does not take its overflow (`html,body{height:100%}` is a `page`). Hidden menus and off-canvas drawers, textareas, selects and strips under 32 px are not parts. |

**Calm capture, same for capture and compare:** reduced motion, CSS animations and caret off,
network idle, `document.fonts.ready`, then layout unchanged for 300 ms; locale `en-US` and
timezone `UTC` unless set. `--clock <ISO>` freezes `Date`
(timers still run) — without it a page that prints the time can never match itself. `compare`
reads clock, locale, timezone, routes and viewports from the baseline's
`baseline-manifest.json`; passing a different clock/locale/timezone is refused (exit 2), a
subset of routes/viewports only has to match itself.

**Threshold** (`--threshold-pct`, default `0.0005`; `--pixel-threshold`, default `0.05`). An
image counts as changed when its size changed, or when more than `threshold-pct` percent of
its pixels differ — measured against at most one 1440×900 screen (1,296,000 px), so a tall
page never tolerates more than ≈6 px. A pixel differs when pixelmatch's colour distance
(0–1, anti-aliasing ignored) exceeds `--pixel-threshold`. Measured, not guessed: three
captures at once next to busy processes differ by 0 px even at distance 0; one changed digit
in a 16 px footer of a 1440×3726 page is 21–24 px; one Tailwind step of a label colour
(`#374151` → `#4b5563`) is 148 px. **Blind spot:** a colour change below distance 0.05
(`#333` → `#3a3a3a`) is not seen — lower `--pixel-threshold` to see it. What stayed below
the threshold is listed in the report: «Below the threshold, not counted: 1 image differs / n images differ
by at most m px». The threshold in px is named in the report header.

**Result:** `report.md` + `report.json` list route · viewport · part · share changed · size
old → new · diff path. Diff images show differing pixels in red (differences that are only anti-aliasing: yellow) over a faded copy. A new
image without baseline is `new` (not an error); a baseline image the new capture lacks is
missing (error); HTTP ≥ 400 and navigation failures are listed as load errors and make the run
fail, they never crash it.

**Exit codes:** `0` no change · `1` change, missing image or load error · `2` wrong call,
unreachable server (checked before anything on disk is touched), invalid config.
`--out` is emptied of earlier baseline files first, but only those files — a folder that
holds other things and no `baseline-manifest.json` is refused. `baseline diff --out DIR`
follows the same rule: DIR must be empty or hold an earlier compare (manifest or compare
`report.json`); without `--out` the report goes into the second folder.

**Config** (`.visual-qa.yml` in the working directory, read by `baseline capture|compare|diff`;
flags win. `run` and `explore` do not read it — they take the flags):

```yaml
baseline:
  routes: [/, /pricing, /about-us]
  viewports:
    - mobile: 390x844
    - desktop: 1440x900
  threshold_pct: 0.0005
  pixel_threshold: 0.05
  clock: 2026-10-05T10:00:00+02:00
  locale: en-US
  timezone: UTC
```

`baseline-capture --url URL --out DIR [--changed-target …]` stays as an alias of
`baseline capture` (`--changed-target` = `--route`). `top` keeps the historic
`<route>/<viewport>.png` path, so `--baseline-dir` for `run`/`explore` keeps working;
`--threshold-pct` applies there too.

**Inner scrollers are not defects.** The layout check reports a tall inner scroll area as
`info` (an app shell is a design choice) and `info` never turns a `PASS` into `UNPROVEN`.
`--internal-scrollers-as-finding` restores the `medium` finding (through the API:
`internalScrollers: "finding"` in `resolveConfig`; `.visual-qa.yml` has no such key).

## Agent loop (short)

1. Build or change the app; start it locally.
2. `visual-qa run --url … --out .qa` — add `--fix-dir` + `--autofix verified`
   and/or `--intent '…'` as needed.
3. `visual-qa report .qa --json` — each `issues[]` entry is a task; fix source,
   re-run until `PASS` or you consciously accept remaining findings.
4. Never ship on `COVERAGE_INCOMPLETE` — raise bounds, re-run.

## Startup app: full visual improvement loop

Use a disposable local/staging environment so form probes can safely exercise
real state without touching customer data:

```sh
visual-qa run --url http://127.0.0.1:3000 --out .qa --isolated
# vision tasks already at .qa/vision/requests.json (or re-export):
visual-qa review-prepare .qa --max-pairs 12
npx impeccable detect src --viewport 390x844
npx impeccable detect src --viewport 1440x900
```

The explorer fills supported fields with deterministic type-aware values,
then probes empty / hostile / overlong input on text-like controls; hovers
before clicks; types into editable comboboxes (typeahead); writes
before / mid / after frames for every observed action; and writes one
full-page image for every newly scanned state. `run` auto-exports harness
vision tasks. Review requests distribute image pairs across layout,
readability, color, slop, and consistency critics. Apply accepted findings, fix via the
repo workflow, then rerun until coverage is complete and the ship gate passes.
`DESIGN.md` is the project style authority; Impeccable and visual-qa complement
it with source-level and rendered-browser evidence.

Default vision path = harness subagents (no API key):

```sh
visual-qa run --url http://127.0.0.1:3000 --out .qa
# .qa/vision/plan.md + batches/batch-XX.json already written
# parent agent: spawn one short-lived smart reviewer per batch → merge → apply
visual-qa review-apply .qa .qa/vision/findings.json

# optional unattended CI via OmniRoute:
# export OPENAI_BASE_URL=http://127.0.0.1:20128/v1 OPENAI_API_KEY=…
# visual-qa run --url … --max-agent-calls 24
```

## CI snippet

```yaml
- run: npx playwright install --with-deps chromium
- run: npm run verify
- run: node bin/visual-qa.mjs demo --out .qa-ci-demo
- run: node -e 'const r=require("./.qa-ci-demo/report.json"); if(r.verdict!=="FAIL") process.exit(1); if((r.duration_ms||0)>180000) process.exit(2)'
```

## License

MIT © Paul Schwarz
