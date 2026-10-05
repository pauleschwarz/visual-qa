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
visual-qa baseline-capture --url URL --out DIR [--path-prefix PATH · --changed-target …]
visual-qa agent-run --url URL [--baseline-url URL] [--out DIR] [--git-ref REF]
visual-qa agent-gate <QA-DIR> <verity.json> [--json] # fail-closed Visual QA + Verity receipt
```

**Output (run/explore):** `--format human|json|junit`, `--out-file FILE` (junit).

**Mode:** `--mode off|changed|full` · `--changed-target URL` (repeatable;
required for `changed`) · `--baseline-dir DIR` (`<route>/<viewport>.png` or
legacy flat) · `--design-contract FILE` (or auto `DESIGN.md`) ·
`--allow-destructive` (only with `--isolated`).

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
  a reason (an alert or status region, or the text in `reason`, for apps not
  in English) and a way
  forward (a focusable control in the content area) that the same page does
  not show without the failure: visual-qa loads the state a second time
  without the injection and counts only what the failure added, so error
  words in normal content, header/nav/footer links or an always-present
  status line cannot pass for an error state. Missing either is a medium
  finding. `expect_api` needs at least one `glob: status` line. A
  failure the page never requests is a low finding: the state was not
  exercised. Any other failing request in the state is a normal finding.
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
