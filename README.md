# visual-qa

Autonomous QA for web apps: it explores your running app like a user, finds
what is broken, fixes what is mechanically fixable, proves every fix — and
blocks the ship when coverage or verdict fails. No human in the loop.

**The use case.** You (or an agent) just built an app. Before it goes out,
one command walks its state graph, clicks every control with an expectation
oracle, reads every screen, and returns a verdict you can act on: `PASS`,
`FAIL`, `UNPROVEN`, or `COVERAGE_INCOMPLETE` — never a quiet "looks fine".

## Quickstart

```sh
npm install -g @pauleschwarz/visual-qa
npx playwright install chromium
visual-qa demo          # under a minute: bundled app with seeded defects
```

The demo finds everything wrong on purpose — overflow, a crashing handler,
placeholder copy — so you see a real `FAIL` report with evidence, not a
green lie. Then point it at your own app:

```sh
visual-qa run --url http://127.0.0.1:3000 --out .qa
```

Deterministic and offline by default. Opt in when you want more:

```sh
# vision review by four prompt skills (layout, readability, slop, consistency)
export VQA_VISION_API_KEY=...
visual-qa run --url http://127.0.0.1:3000 --max-agent-calls 8

# verified autofix + a visual change instruction, DE or EN
visual-qa run --url http://127.0.0.1:3000 --autofix verified --fix-dir ./app \
  --intent 'ändere die Farbe von "Add item" auf grün'
```

## Using it from an agent harness

visual-qa is a CLI tool, not a service: start it, read the result, act.
The whole integration contract is three things.

**Exit codes.** `0` = `PASS`. `1` = run happened, verdict is not `PASS`
(findings or incomplete coverage — the report says which). `2` = blocked
(bad arguments, unreachable URL, refused mode).

**One summary command.** After a run, a harness reads the compact summary
instead of the full report:

```sh
visual-qa report .qa --json
```

```json
{
  "verdict": "FAIL",
  "limit_reason": null,
  "coverage": { "states": 4, "actions": 9, "viewports": ["mobile", "desktop"] },
  "issue_count": 6,
  "by_severity": { "high": 4, "medium": 1, "low": 1 },
  "issues": [{ "id": "...", "type": "vqa-functional", "severity": "high", "title": "Dead button", "detail": "..." }],
  "phases": { "fix": { "applied": [] } },
  "artifacts": { "report_md": "report.md", "screenshots": "screenshots/" }
}
```

**A working loop.** The intended agent loop, no orchestration framework
needed:

1. Build or change the app; start it locally.
2. `visual-qa run --url ... --out .qa` (add `--fix-dir <app-source>
   --autofix verified` to let it fix and prove title/lang/contrast).
3. `visual-qa report .qa --json` — treat each `issues[]` entry as a task:
   fix the source, then re-run until the verdict is `PASS` or you accept
   the remaining findings consciously.
4. Never ship on `COVERAGE_INCOMPLETE` — raise the bounds flags and re-run
   instead.

The full machine contract (verdict policy, intent catalog, autofix
whitelist, artifact layout) lives in
[`schemas/intent-catalog.json`](schemas/intent-catalog.json).

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

## How it decides

- Deterministic checks are authoritative: axe WCAG (violations *and*
  contrast nodes axe could not measure), layout and scroll probes, console,
  page and network failures, slop heuristics, and — only in `--isolated`
  environments — security probes.
- Vision models are additive only. The orchestrator stays deterministic and
  merely dispatches screenshot pairs to review skills; their findings cap at
  `medium`, so a model can enrich a report but never fail or clear a run.
- An instruction outside the intent catalog is reported as unparsed, never
  guessed. An unfulfillable one is a finding, never a silent no-op.
- A fix only counts when a complete fresh exploration no longer reports it.
- `COVERAGE_INCOMPLETE` is never a pass.

## What it can fix (whitelist)

| Finding | Fix | Proof |
| --- | --- | --- |
| Missing `<title>` / `lang` | insert into fix-dir sources | fresh run clears the axe rule |
| WCAG contrast violation | parse axe summary, blend foreground minimally to 4.5:1 (3:1 large text) | fresh run clears the node |
| `--intent` style change (color, background, font-size, gap, padding, margin) | patch inline style as resolved CSS | computed style matches in fresh run |

Everything else stays a finding with evidence: before/after screenshots,
ARIA/DOM snapshots, traces, and per-call model responses. Unfixable targets
appear in an honest skip list (`selector_unsupported`, `unparsable_summary`),
never as silent drops.

Full contract: [`schemas/intent-catalog.json`](schemas/intent-catalog.json).

## Safety

- Destructive labels (delete, pay, unsubscribe, …) are refused; mutating
  labels require `--isolated`.
- External links are never followed; off-origin events are excluded.
- Secrets are redacted before evidence reaches disk; reports are `0600`.
- Every patch leaves before/after copies in `<out>/fixes/` and
  `<out>/intent/`, and every run carries a `run_id`.

## Output

Per run: `report.json` (machine), `report.md` (verdict, phases, issues),
`screenshots/`, `traces/`, `vision/`, `fixes/`, `intent/`, `verify/`.

```
Visual QA PASS | states=2 actions=4 issues=0
  intent: parsed=true applied=true
  fix:    contrast #notice 1.61 -> rgb(118, 118, 118)
  verify: PASS complete fixed=3 remaining=0
```

## Development

```sh
npm install && npx playwright install chromium
npm run verify      # unit + e2e against the seeded-defect fixture
npm run fixture     # serves the defect fixture on :4173
```

The fixture intentionally seeds dead controls, a crashing handler, a failing
API call, overflow, placeholder copy, and an unnamed button — so the test
suite proves the runtime finds what matters, not that it stays green.

License: MIT.
