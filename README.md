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
visual-qa run --url http://127.0.0.1:4173 --out .qa
```

Everything runs deterministic and offline by default. Add intelligence when
you want it:

```sh
# vision review by four prompt skills (layout, readability, slop, consistency)
export VQA_VISION_API_KEY=...
visual-qa run --url http://127.0.0.1:4173 --max-agent-calls 8

# verified autofix + a visual change instruction, DE or EN
visual-qa run --url http://127.0.0.1:4173 --autofix verified --fix-dir ./app \
  --intent 'ändere die Farbe von "Add item" auf grün'
```

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
