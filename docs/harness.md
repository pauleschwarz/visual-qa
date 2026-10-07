# Using visual-qa from an agent harness

visual-qa is a CLI tool, not a service: start it, read the result, act.
No daemon and no framework: it runs as a `visual-qa` subprocess and writes a
bounded evidence directory. Until the npm package is published, install the
public repository directly.

## Install (once)

```sh
git clone https://github.com/pauleschwarz/visual-qa.git
cd visual-qa
npm ci
npx playwright install chromium
npm link
```

After npm publication, the clone/install/link steps can be replaced with
`npm install -g @pauleschwarz/visual-qa`.

## The contract

**Exit codes.** `0` = verdict `PASS`. `1` = a run happened and the verdict
is not `PASS` (findings or incomplete coverage — the report says which).
`2` = blocked (bad arguments, unreachable URL, refused mode). `visual-qa
demo` exits `0` even with findings: the fixture is defective on purpose.

**One summary command.** After any run:

```sh
visual-qa report .qa --json
```

Returns the compact summary: `verdict`, `run_id`, `complete`,
`limit_reason`, `coverage`, `issue_count`, `by_severity`, severity-prioritized
`issues[]` (`id`, `type`, `severity`, `title`, `detail`), `phases`, `artifacts`.
Human-readable without `--json`. Each run also writes a portable
`report.html` inspection docket and `report.md`.

**CI output.** `run` and `explore` accept `--format human|junit|json` (human is
the default):

```sh
visual-qa run --url http://127.0.0.1:3000 --format junit --out-file qa.junit.xml
```

JUnit: one testcase per issue; critical/high become `<failure>`,
medium/low stay `<system-out>` notes. `COVERAGE_INCOMPLETE` is always a
failure so a pipeline can never read an unexplored run as a pass.
`--format json` prints the summary to stdout.

## Agent gate: Visual QA + Pi Verity

`visual-qa` and [Pi Verity](https://github.com/pauleschwarz/pi-verity)
cover different failure classes. Visual QA proves a bounded running-app walk;
Verity binds repository checks and evidence to an exact Git state. Neither is a
replacement for the other.

```sh
# 1. Agent changes source and runs the app locally.
visual-qa run --url "$APP_URL" --out .qa
# Complete default harness vision review, then apply its findings:
visual-qa review-apply .qa .qa/vision/findings.json

# 2. Outer verifier inspects this repository. It never runs from visual-qa.
npx --no-install pi-verity verify . --output .qa/verity.json

# 3. Pure, fail-closed evidence join. No browser, agent, or verifier subprocess.
visual-qa agent-gate .qa .qa/verity.json --json
```

Only `agent-gate` exit `0` permits a completion claim. It requires:

- Visual QA `verdict=PASS`, `complete=true`, no critical/high issues, and no
  unfinished vision review (`coverage.vision_complete=true`; every planned
  request ID answered exactly once).
- Pi Verity `PASS` (warnings require human review), with no stale receipt.
- Verity receipt timestamp not older than completed Visual QA evidence.
- When the report was produced by `agent-run`: non-empty Git HEAD/ref/diff SHA;
  design-contract path+sha256 when a DESIGN.md was bound; `fixer_applied` must
  stay false; `review_fix_loops` must not exceed `policy.max_review_fix_loops` (2).

Anything else exits `1` with named blockers and writes `.qa/agent-gate.json`.
Unreadable/malformed evidence exits `2`. The gate never edits app source, starts
processes, calls models, or publishes. It cannot make a non-PASS report pass.

## agent-run (observe-only wrapper)

```sh
# Optional project config at .visual-qa.yml
# trigger: ["src/components/**"]
# ignore: ["**/*.test.tsx"]
# route_map:
#   "src/components/**": ["/", "/orders@orders-error"]   # path@state: a named state
#   "app/pages/**": FULL

visual-qa agent-run --url http://127.0.0.1:3000 \
  --baseline-url http://127.0.0.1:3001 \
  --out .qa-agent \
  --base origin/main
```

- `path@state` routes capture a state defined under `states:` (sign-in, injected
  API failure; see README "States, sign-in and journeys"); plain routes are walked.
  Unknown keys in the config are printed as warnings and listed in
  `agent-run.json` as `config_warnings`.
- Changed files = merge-base with the base branch → working tree, plus untracked
  (`--base`, `base:`, default `origin/HEAD` → `main` → `master`; none resolvable → exit 2).
  `route_map` values: a route list, `GLOBAL`/`FULL`, `IMPORTERS`; `route_map_mode: first`,
  `aliases`, `import_depth`, `server: {command, health}` — README "Check only what you changed".
  The report lists why each route is there (`route_reasons`, `full_reasons`).
- No UI-path git diff → exit 0 noop PASS (no browser).
- UI diff without matching `route_map` → fail-closed.
- Never applies fixers; evidence + compare only. Coding agents may loop
  review→fix at most twice (`max_review_fix_loops` in `.visual-qa.yml`).
- `baseline capture` writes `<route-key>/<viewport>[.page|.scroller-<n>].png` plus
  `baseline-manifest.json` from a live URL; `baseline compare` / `baseline diff` produce
  `report.md`, `report.json` and `diff/*.png` (exit 0 / 1 / 2 — see README "Baselines").
  `baseline-capture` is kept as an alias.

## States, sign-in and journeys

For apps behind a login, or error paths that need a failing server, name the
state instead of hoping the walk finds it. Contract for agents:

- Config in `.visual-qa.yml`: `setup`, `storage_state`, `states`, `journeys`
  (full example and semantics: README "States, sign-in and journeys").
- `visual-qa run|explore --state NAME … --journey NAME …` and
  `visual-qa journeys --url URL [--only a,b | --journey NAME …]` run exactly what is named
  (no base-URL walk), per viewport.
- Evidence for the vision review and for you: `screenshots/appstate-*.png` with
  the visible text in a `.txt` of the same name; `journeys/<name>/<viewport>/NN-*.png`
  with `.txt`. Both are `state_scan` entries in `report.json`.
- A red journey check is `FAIL` (exit `1`) with the step named in the issue
  title and a `…-FAILED.png`. A broken setup/journey file is exit `2`, never a finding.
- An injected failure (`expect_api`) is expected, so its 4xx/5xx is not a
  finding; an error state with no new alert/alertdialog/status/dialog text (or `reason:` text)
  or no new focusable control is (`medium`), judged against the same state loaded without the
  failure (costs one more load per error state and viewport; `setup` runs again). Plain red
  text without a role counts only through `reason:` in the state.

## DESIGN.md

- `--design-contract FILE` fails early if missing/unreadable.
- If `DESIGN.md` exists in the invoking project root, it is auto-discovered.
- SHA-256 + path land in `report.json`; every vision request prompt includes the
  contract and preservation rules. visual-qa does not redesign the product.

**Important:** run Pi Verity last. Any repository change after its receipt makes
that receipt stale; re-run the verifier and then `agent-gate`. For a regression,
add a narrow candidate test first so Verity can prove baseline RED → candidate
GREEN. `UNPROVEN` is evidence missing, not permission to ship.

## The agent loop

1. Build or change the app; start it locally.
2. `visual-qa run --url ... --out .qa` — add `--fix-dir <app-source>
   --autofix verified` to let it fix and prove title/lang/contrast, and
   `--intent '<instruction>'` for a visual change (DE/EN).
3. `visual-qa report .qa --json` — treat each `issues[]` entry as a task:
   fix the source, then re-run until the verdict is `PASS` or the remaining
   findings are consciously accepted.
4. Never ship on `COVERAGE_INCOMPLETE` — raise the bounds flags and re-run.

## Pre-flight without a browser

`visual-qa intent` dry-runs instructions against the static sources: is an
instruction in the catalog at all, and does its target exist in the HTML?

```sh
visual-qa intent --fix-dir ./app \
  --intent 'ändere die Farbe von "Add item" auf grün' \
  --intent 'mach es schöner'
# FOUND ./app/index.html: ändere die Farbe von "Add item" auf grün
# UNPARSED: mach es schöner          (exit 1)
```

`--json` returns `{ ok, results: [{ intent, parsed, found, file, reason }] }`.
Use it before a real run to validate what the agent is about to ask for.

## Vision review (required on `run`)

`visual-qa run` is fail-closed on vision. After the deterministic walk it
exports harness tasks to `.qa/vision/requests.json` (opt out of *export* with
`--no-prepare-review`; that does **not** make the run complete). Without either
a completed built-in vision pass or `review-apply`, the report sets
`coverage.vision_complete=false`, `complete=false`, and adds high finding
`vqa-vision-required-unavailable`.

Vision findings stay additive and severity-capped at `medium` (they flag; they
do not alone flip FAIL). Missing vision is different: it blocks completeness.

**Option B — DEFAULT: calling agent / subagents (no key).** After `run`,
`.qa/vision/` already has `plan.md`, `plan.json`, and `batches/batch-XX.json`.
Agent-loop defaults are deliberately bounded: at most 3 unique state pairs plus
3 action pairs, reviewed by all six critics (`layout`, `readability`, `color`,
`slop`, `consistency`, `preservation`), with 6 requests per batch. This avoids
an unbounded state × skill explosion while still checking composition,
legibility, palette, system consistency, generic AI slop, and `DESIGN.md`
preservation. Override with `--max-pairs`, `--max-state-pairs`, `--batch-size`,
and `--skills loop|all|layout,readability,...` when a deeper audit is intended.

The parent agent spawns one short-lived reviewer per batch (same model family,
e.g. `smart`): open batch → vision-read every `before_abs`/`after_abs` → return
one JSON finding set for every request id → exit. Parent merges into
`vision/findings.json`, runs `review-apply`, and must verify
`coverage.vision_complete=true`. Open → review → close. No OmniRoute key required.

```sh
visual-qa run --url http://127.0.0.1:3000 --out .qa
# or re-export:
visual-qa review-prepare .qa --max-pairs 3 --max-state-pairs 3 --batch-size 6 --skills loop
# -> .qa/vision/plan.md + batches/batch-01.json …
# spawn N subagents (smart), merge results, then:
visual-qa review-apply .qa .qa/vision/findings.json
```

**Option A — endpoint (OmniRoute bus / OpenAI-compatible).** Unattended screenshot
review. Auth: `VQA_VISION_API_KEY` → `OPENAI_API_KEY` → `OMNIROUTE_API_KEY`.
Endpoint: `VQA_VISION_ENDPOINT` → `OPENAI_BASE_URL` → if only OmniRoute is keyed,
`http://127.0.0.1:20128/v1` (never `api.openai.com` with an OmniRoute key).
Models: `VQA_VISION_MODELS` or, on OmniRoute, pinned combos `vision` then `smart`
(gateway resolves vision underlyings). Full catalog rank: `VQA_VISION_DISCOVER=1`.
Budget auto-arms when a key is present (`VQA_VISION_DISABLE=1` to opt out).

Apply validates the answers, caps `high` at `medium`, records request ids
(re-applying is a no-op, retries cannot duplicate), recomputes the verdict,
and rewrites `report.json`/`report.md`. Deterministic findings are never
removed or downgraded.

## Programmatic use

The package exports the same machinery the CLI uses:

```js
import { run, explore, parseIntent, dryRunIntent, summarizeReport } from "@pauleschwarz/visual-qa";
const report = await run({ baseUrl: "http://127.0.0.1:3000", outDir: ".qa" });
const summary = summarizeReport(report);
```

## Limits, stated honestly

- Fixable sources are **static HTML** in `--fix-dir` (inline-style patches,
  document title/lang). React/Vue components are findings, not patches.
- The intent catalog is deliberately small: color, background, font-size,
  gap, padding, margin against text or tag targets. Anything else reports
  as unparsed.
- Contrast fixes need axe to measure — unverifiable nodes are reported
  (`color-contrast-incomplete`), not auto-fixed.
- Exploration is bounded BFS with semantic-state identity. Authenticated
  and mid-flow pages are reached by naming them (`setup` / `storage_state`,
  `states`, `journeys`, see above); the plain walk only sees what a visitor
  can reach by clicking.
- Vision findings are capped at `medium`: they flag, they never gate.
