# visual-qa

Autonomous visual and contextual QA runtime for running web applications.
One bounded exploration pass per viewport: it walks the app's state graph,
acts on every interactive control with an expectation-based oracle, and runs
deterministic checks plus opt-in vision review and verified autofix — no
human in the loop.

## How it decides

- **Deterministic checks are authoritative.** a11y, layout, scroll, runtime,
  functional semantics, slop heuristics, and (in isolated environments)
  security probes produce hard findings.
- **Vision models are additive only.** They review before/after screenshots
  and may add findings (capped at `medium` severity); they can never remove or
  downgrade a deterministic result.
- **Coverage gates the verdict.** `COVERAGE_INCOMPLETE` is never a pass; a
  bounded run must prove it explored, not merely find nothing.
- **A fix only counts when verified.** Whitelisted document fixes (title,
  lang) are applied to `--fix-dir`, then a fresh complete exploration must
  clear the issue.

## Stages (`visual-qa run`)

1. `explore` — bounded BFS over states (per viewport), expectation oracle,
   pixel diff, screenshots, traces.
2. `checks` — axe-core WCAG, layout/scroll probes, console/page/network,
   slop heuristics; security probes when `--isolated`.
3. `vision` — screenshot review via an OpenAI-compatible endpoint; opt-in
   through `--max-agent-calls` and `VQA_VISION_API_KEY`.
4. `fix`/`verify` — apply whitelisted fixes, re-explore, diff issue sets.
5. `aggregate` — final verdict, `report.json`, `report.md`.

## Usage

```sh
visual-qa run --url http://127.0.0.1:4173 --out .qa \
  --isolated --autofix verified --fix-dir ./app --max-agent-calls 4
visual-qa explore --url http://127.0.0.1:4173   # deterministic core only
```

Bounds flags: `--max-states`, `--max-depth`, `--max-actions`,
`--max-actions-per-state`, `--max-runtime-ms`, `--max-agent-calls`.
Defaults are mutually coherent (40 states × 6 actions ≈ 15 min wall clock).

Exit code: `PASS` → 0, everything else → 1, blocked → 2.

### Vision environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `VQA_VISION_API_KEY` | enables the vision stage | — (skips without) |
| `VQA_VISION_ENDPOINT` | OpenAI-compatible base URL | `https://api.openai.com/v1` |
| `VQA_VISION_MODEL` | multimodal model | `gpt-4o-mini` |

Without a key or `--max-agent-calls`, the stage reports
`skipped_no_endpoint` / `skipped_no_calls` and the run stays fully
deterministic.

### Safety

- Destructive labels (delete, pay, unsubscribe, …) are refused unless
  `--isolated` is set; mutating labels additionally require an isolated
  environment.
- External-origin links are never followed; off-origin events are excluded
  from findings.
- Secrets are redacted from evidence before it reaches disk; report files are
  written `0600`.

## Development

```sh
npm install && npx playwright install chromium
npm run verify        # unit + e2e against the defect fixture
npm run fixture       # serves the seeded-defect fixture on :4173
```

The fixture intentionally seeds dead controls, a crashing handler, a failing
API call, overflow, a tiny unnamed button, and placeholder copy.

License: MIT.
