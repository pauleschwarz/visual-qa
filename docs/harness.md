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

**CI output.** `run` and `explore` accept `--format junit|json`:

```sh
visual-qa run --url http://127.0.0.1:3000 --format junit --out-file qa.junit.xml
```

JUnit: one testcase per issue; critical/high become `<failure>`,
medium/low stay `<system-out>` notes. `COVERAGE_INCOMPLETE` is always a
failure so a pipeline can never read an unexplored run as a pass.
`--format json` prints the summary to stdout.

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
The parent agent spawns one short-lived reviewer per batch (same model family,
e.g. `smart`): open batch → vision-read `before_abs`/`after_abs` → JSON findings
→ exit. Parent merges into `vision/findings.json` and runs `review-apply`.
Open → review → close. No OmniRoute key required.

```sh
visual-qa run --url http://127.0.0.1:3000 --out .qa
# or re-export:
visual-qa review-prepare .qa --max-pairs 6 --batch-size 4
# -> .qa/vision/plan.md + batches/batch-01.json …
# spawn N subagents (smart), merge results, then:
visual-qa review-apply .qa .qa/vision/findings.json
```

**Option A — optional endpoint (OmniRoute / OpenAI-compatible).** For unattended
CI only. Auth via `VQA_VISION_API_KEY` or `OPENAI_API_KEY` or `OMNIROUTE_API_KEY`.
Endpoint via `VQA_VISION_ENDPOINT` or `OPENAI_BASE_URL`. Auto-arms budget when a
key is present (`VQA_VISION_DISABLE=1` to opt out). Models via `VQA_VISION_MODELS`
or `GET /models`. Same five skills, round-robin across models.

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
- Exploration is bounded BFS with semantic-state identity; deep
  authenticated flows need an app-level login or a reachable session URL.
- Vision findings are capped at `medium`: they flag, they never gate.
