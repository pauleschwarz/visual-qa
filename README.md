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

**Known limits:** visual-qa never guesses credentials. The explorer fills
placeholder test values, so login-gated pages are reached only when you
describe the signed-in state yourself (see
[States, sign-in and journeys](#states-sign-in-and-journeys)). Hover and
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
- The app is behind auth and you cannot or will not describe a signed-in
  state (a setup hook or a storage-state file, see below).
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
              [--state NAME …] [--journey NAME …] [--config FILE]   # named states / journeys
visual-qa journeys --url URL [--only a,b | --journey NAME ...] [--out DIR] [--config FILE]
visual-qa explore --url URL [--out DIR] [bounds]     # deterministic core only
visual-qa report <DIR> [--json]                      # agent-friendly summary
visual-qa intent --intent "…" --fix-dir DIR [--json]  # catalog dry-run, no browser
visual-qa review-prepare <DIR> [--max-pairs N]       # export vision tasks for your model
visual-qa review-apply <DIR> <findings.json>         # apply findings (fail-closed full-ID coverage)
visual-qa baseline capture|compare|diff …            # see "Baselines" below
visual-qa geometry --url URL [--sweep 320-1440:40] …  # see "Geometry" below
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

## States, sign-in and journeys

By default visual-qa walks what an anonymous visitor reaches. To look at the
app the way a signed-in user sees it, or the way a user sees it when the
server fails, describe that state once in `.visual-qa.yml` (in the directory
you run from, or `--config FILE`; relative paths resolve from that file).

`.visual-qa.yml`:

```yaml
# Paths are relative to this file.
setup: ./vqa.setup.mjs

states:
  orders:
    path: /orders
  orders-error:
    path: /orders
    expect_api:
      "**/api/orders": 500
  signed-out:
    path: /login
    fresh: true

journeys:
  checkout: ./checkout.journey.mjs
```

`vqa.setup.mjs` runs before every state and journey, on a fresh page, before
anything is opened. Set cookies, seed storage, stub routes. Read secrets from
the environment, never from the repo:

```js
// Runs before every state and journey. `page` is a fresh Playwright page;
// ctx is { baseUrl, state, viewport, locale }.
export async function setup(page, ctx) {
  await page.context().addCookies([
    { name: "sid", value: "demo", url: ctx.baseUrl },
  ]);
}
```

`checkout.journey.mjs` is a journey: the path a user must be able to finish.

```js
// step(name, async (page, ctx) => …) acts; check(name, async (page, ctx) => …)
// returns true, or false / a string saying why not. The first red one stops
// the journey with a stop image.
// page.goto("/path") resolves against the --url under test.
export default async function ({ step, check }) {
  await step("open checkout", (page) => page.goto("/checkout"));
  await step("continue", (page) =>
    page.getByRole("button", { name: "Continue" }).click(),
  );
  await check("second step is shown", (page) =>
    page.getByRole("heading", { name: /step 2 of 2/ }).isVisible(),
  );
  await step("place order", (page) =>
    page.getByRole("button", { name: "Place order" }).click(),
  );
  await check("order is confirmed", (page) =>
    page.getByRole("heading", { name: "Order placed" }).isVisible(),
  );
}
```

Run them (to try it, use the sample app in a Git checkout:
`PORT=4174 node fixture/app-server.mjs &`, then `cd fixture/example`):

```sh
visual-qa explore --url http://127.0.0.1:4174 --state orders --state orders-error --state signed-out --journey checkout
visual-qa journeys --url http://127.0.0.1:4174          # every journey in the config
```

- **Sessions.** `setup` exports `setup(page, ctx)` with
  `ctx = { baseUrl, state, viewport, locale }` (`state` is the state's name,
  also for `path@state`; `null` in a journey). Instead of (or together with)
  a hook, `storage_state: ./auth.json` loads a Playwright storage-state file
  (cookies and local storage; it holds live sessions, keep it out of git).
  `fresh: true` on a state or journey skips the session, so a signed-out page
  or a real sign-in flow starts cold.
- **States.** `path` is required. `setup: <name>` also runs that extra export of
  the setup file. `path@state` (`--state /orders/42@orders-error`, or a
  `route_map` entry for `agent-run`) captures the same state on another path.
  Each state gets a full-page image and the visible text next to it
  (`screenshots/appstate-<state>-<viewport>.png` and `.txt`) and goes through
  the accessibility, layout, scroll (fixed chrome, blank runs), placeholder-copy
  and runtime checks of an explored page.
- **Failures on demand.** `expect_api` (alias `fail_api`) maps a URL glob to an
  HTTP error status or `timeout` (the request is aborted as timed out).
  The injected failure itself is not a finding. The *error state* must show
  a reason and a way forward that the same page does not show without the
  failure. Reason: new text in an alert, alertdialog, status or live region
  (`role=alert|alertdialog|status`, `aria-live`) or an open `<dialog>`, or the
  text you put in `reason: "…"`. If your page shows the error as plain text
  (a red `<p>`, no role) or in another language than you search for, add
  `reason:`; without it the finding says so. Way forward: a focusable control
  in the content area (retry, back, link) that is new. visual-qa loads the
  state a second time without the injection and counts only what the failure
  added, so error words in normal content, header/nav/footer links or an
  always-present status line cannot pass for an error state. Digits are
  ignored in that comparison (a clock or counter is not new); text that changes
  in words between two loads can still look new, `reason:` makes the reason
  check independent of it.
  Missing either is a medium finding. Cost: every error state is loaded once
  more per viewport (the `setup` hooks run again). `expect_api` needs at least
  one `glob: status` line. A failure the page never requests is a low finding:
  the state was not exercised. Any other failing request in the state is a
  normal finding.
- **Journeys.** `step(name, async (page, ctx) => …)` acts, `check(name, async
  (page, ctx) => …)` returns `true` (holds), or `false` / a string with the
  reason. Every step leaves an image and a text file
  (`journeys/<name>/<viewport>/NN-<step>.png`); after every green one the
  accessibility and layout checks run on the page it left. `page.goto("/cart")`
  resolves against `--url`. The first red step or check
  fails the run (`high`), names the step, writes a `…-FAILED.png` stop image
  and skips the rest. A step that cannot find its target fails after 15 s, not Playwright's 30 s.
  Value forms: `name: ./file.mjs`, or `name:` with `file:` and `fresh: true`.
- **Scope.** Naming a state or journey narrows the run to what you named; the
  plain walk of the base URL happens when you name nothing. On `run`, vision
  review still applies to the images.
- **Your files are not findings.** A missing or throwing setup, a missing
  `storage_state` file, an unknown state, or a journey file with a syntax error
  stops the run with exit `2` and the file named. Unknown keys in
  `.visual-qa.yml` are printed as warnings.

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
| `scroller-<n>` | every inner scroll area, shown whole (DOM order). The area and its parents are stretched, fixed/sticky chrome elsewhere (header, rail, composer, cookie banner) is hidden so it cannot cover content, and everything is put back afterwards. A scrolling `<body>` counts only when `<html>` is not `visible` in both axes (the viewport then cannot take the body's overflow); with `html,body{height:100%}` the page scrolls and it is a `page`. Scrollers hidden by `visibility:hidden`, `display:none` or `content-visibility:hidden`, textareas, selects and strips under 32 px are not parts. A scroller that cannot be photographed whole — no box when grown, a grown box shorter than nine tenths of its content (content outside the flow, or children sized in % of the box), removed by the page, or no picture within 5 s — is skipped and listed under «Not captured»; it never fails the capture. |

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
page never tolerates more than ≈6 px and a phone screen (390×844) tolerates ≈1.6 px — the report
names the cap. A pixel differs when pixelmatch's colour distance
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

## Geometry

What people measure by hand when a page "looks off", as one command: is the call to action above the fold,
does a fixed bar cover content, does a neighbour jump when something changes, are edges a few pixels off flush,
does text fit its box, do the texts of a row keep their distance and baseline, is a tap target big enough.
Each finding comes with a number in px and one image with the box outlined.

```bash
# every default check, widths 320–1440 in steps of 40 (each width a fresh page), 800 px high
visual-qa geometry --url http://127.0.0.1:3000 --sweep 320-1440:40 --route / --route /pricing

# named windows instead of (or besides) a sweep; the CTA must be above the fold of a laptop screen
visual-qa geometry --url http://127.0.0.1:3000 --viewport laptop=1280x600 --viewport phone=390x844 \
  --selector first-view=".hero .cta"

# the Save button changes its label while saving: does anything next to it move?
visual-qa geometry --url http://127.0.0.1:3000 --route /settings --selector stable="#save"
```

| Check | Finds | Measure |
| --- | --- | --- |
| `first-view` | an element matching `--selector first-view=CSS` that does not end above the fold (also: matches nothing, or nothing visible) | px below the fold |
| `covered` | a fixed or sticky element over content that no scrolling clears (the browser's centred scroll-into-view is clamped at the page ends and never passes a side rail), or over a control once the browser has scrolled it into view as it does on focus (`scroll-padding` fixes the second). A bar over content that scrolls out from under it is not a finding; an open modal is skipped. It scrolls to every content element, so a page with more than 10000 of them is not measured to the end: the run is blocked and says so (see "Result") | % of the element under the bar |
| `stable` | elements that move between two states of one page: `--selector stable=CSS` clicks that element (`stable=hover:CSS` hovers it) and compares every visible box before and after; the trigger, its parents and children do not count, only the topmost mover is reported. A trigger that navigates away or reloads the page leaves nothing to compare with: that is an error, not "nothing moved" | px moved |
| `edges` | stacked blocks whose left edges (and, when both have a background or border, right edges) are 1–4 px apart: nearly flush, not flush. Centred parents are skipped | px |
| `text-fit` | text cut off by its box (`overflow:hidden`), an ellipsis or line clamp without `title`/`aria-label`, text sticking out of its box | px cut / out |
| `row-align` | texts of sibling boxes on one line closer than `--min-gap` (default 6 px; overlap is `high`), and equally sized texts on one line whose baselines are 1 px or more apart (under 2 px is `low`). Words inside one sentence (inline elements) are not boxes of a row, a table row is not one either (its cells are), and a cell that spans rows is not compared for its baseline. Baselines are compared between boxes of the same number of lines: a cell centred in its row beside a taller one is placed so, not misaligned | px gap / px off |
| `tap-size` | tap area below 44 px in either direction, and tap areas of two controls that overlap. The area is measured with `elementFromPoint` (box, label and `::after` reach count); a link inside a sentence is exempt, also when it sits in an `<em>`, `<sup>` or the like (the text of its nearest block counts). Overlap is what the screen shows at one scroll position: each control's rect is cut at the boxes that clip it (`overflow` auto, scroll, hidden or clip) — except the ones both controls sit in, whose content scrolls together — and controls of the page are compared with each other, controls of fixed or sticky elements with each other (a bar over the page links is `covered`'s, not an overlap). Only at widths up to `--touch-max` (default 820); the report says how often it ran | px, smaller side |

`first-view` and `stable` need to be told where to look and run only when their `--selector` is given;
`--checks a,b` narrows the set (a check that lacks its selector is a call error).

**Sweep and ranges.** `--sweep FROM-TO[:STEP]` (step defaults to 40, TO is always measured, `--height N` sets the height, default 800)
and `--viewport name=WxH` (repeatable) add up; with neither, mobile 390×844 and desktop 1440×900. Every
viewport opens a new page, so the page is what a visitor gets at that width. A finding that exists at 320–440 px is one
finding with that range and its worst width, not one per width. Images are taken at the worst width, the worst of each kind first,
at most 40; the rest is in `report.json`. A sweep of 29 widths on the bundled demo takes about 30 s.
The sweep is a sample: a defect that exists only in a range narrower than STEP (363–381 px at step 40) can fall between two widths.
Name such a width with `--viewport`, or use a smaller step.

**States.** `--state NAME` (repeatable, `.visual-qa.yml` or `--config FILE`, see "States, sign-in and journeys")
measures the page a state's setup leaves instead of `--route`; routes are visited as an anonymous visitor.

**Result.** `<out>/report.md`, `report.json` (`schema_version: vqa-geometry-0.1`; per finding `check`, `kind`, `severity`,
`selector`, `route`, `state`, `viewports`, `widths`, `measure`, `worst`, `image`) and `images/`. A finding's selector is a short
CSS path (an id, `data-testid` or tag and classes with `:nth-of-type`). Exit `0` nothing found, `1` findings, `2` not
everything could be measured: a call error, unreachable server, a page that does not load (HTTP ≥ 400 included), a trigger that
matches nothing or replaces the page, a page with more content than `covered` walks. Such a run lists its errors in the report and is never `PASS`.

Nothing is cut silently. Of each kind of finding, the worst 100 per page are kept (the smallest gap or tap area, the largest of every other number);
what is left out is counted in `truncated` (`report.json`) and listed under "Cut short" in `report.md`. A cut that leaves part
of the page unmeasured (`cut: "targets"`) blocks the run and the check counts as not run in `coverage`; a cut list of findings
(`cut: "findings"`) is still a failing run. A finding with a box below the 2400 px a picture shows names the box's position in
`image_note`.

**What it is not.** Findings are measurements of a rendering, not verdicts on design: a deliberate overlay, a tooltip that opens in the
flow, an indent of 3 px on purpose are all findings; look at the image. On a real page expect many small findings (tap targets of
every inline link in a table); the report lists the worst ten of each kind and keeps the worst 100 of each kind in `report.json`.

**In `run`/`explore`:** `--geometry` adds the checks that need no input (`covered`, `edges`, `text-fit`, `row-align`, `tap-size`)
to every scanned state at its viewport, as `vqa-geometry` issues. Off by default; `--state` captures are not part of it, use
`visual-qa geometry --state`.

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
