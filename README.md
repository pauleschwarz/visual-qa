# visual-qa

Autonomous QA for web apps: it explores your running app like a user, finds
what is broken, fixes what is mechanically fixable, proves every fix — and
blocks the ship when coverage or verdict fails. No human in the loop.

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

Deterministic and offline by default. `--format junit` plugs into CI,
`--max-agent-calls` adds vision review, `--autofix verified --fix-dir ./app`
lets it fix and prove title/lang/contrast, and `--intent 'ändere die Farbe
von "Add item" auf grün'` applies a verified visual change (DE or EN).

## Verdicts

`PASS` — explored completely, zero blocking findings. `FAIL` — findings
exist. `UNPROVEN` — clean, but only low-severity notes. `COVERAGE_INCOMPLETE`
— the bounded budget stopped the walk; never a pass, raise the bounds and
re-run.

## Using it from an agent harness

visual-qa is a CLI tool, not a service: start it, read the result, act.
The whole contract — exit codes, `visual-qa report .qa --json`, the
`--format junit` CI hook, the intent dry-run command, and the agent loop —
is documented in [`docs/harness.md`](docs/harness.md), and the machine
contract (verdict policy, intent catalog, autofix whitelist) in
[`schemas/intent-catalog.json`](schemas/intent-catalog.json).

## Safety

- Destructive labels (delete, pay, unsubscribe, …) are refused; mutating
  labels require `--isolated`.
- External links are never followed; off-origin events are excluded.
- Secrets are redacted before evidence reaches disk; reports are `0600`.
- Every patch leaves before/after copies in `<out>/fixes/` and
  `<out>/intent/`, and every run carries a `run_id`.

## Development

```sh
npm install && npx playwright install chromium
npm run verify      # unit + e2e against the seeded-defect fixture
npm run fixture     # serves the defect fixture on :4173
```

License: MIT.
