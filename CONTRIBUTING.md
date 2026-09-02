# Contributing to visual-qa

## Principles

1. **Verdict honesty.** `COVERAGE_INCOMPLETE` and `UNPROVEN` must never collapse
   into `PASS`. CI must fail closed on incomplete exploration.
2. **Deterministic core first.** Browser exploration and mechanical checks stay
   offline-capable; vision/harness review is additive via
   `review-prepare` / `review-apply`.
3. **Safety defaults.** Destructive flows stay refused unless `--isolated` (and
   explicit allow) says otherwise. Secrets never land unredacted in `out/`.
4. **CLI is the API.** Flag renames are breaking; document in README +
   `docs/harness.md` in the same PR.

## Setup

```bash
git clone https://github.com/pauleschwarz/visual-qa.git
cd visual-qa
npm ci
npx playwright install chromium
npm run verify
```

Node 20+ recommended (CI uses 20).

## Project map

| Path | Role |
| --- | --- |
| `bin/visual-qa.mjs` | CLI entry + usage text |
| `src/` | explore, run, report, intent, review, junit, demo |
| `schemas/` | intent catalog / machine contract |
| `fixture/` | seeded-defect app for demo + e2e |
| `docs/` | harness contract, plans |
| `test/` | unit tests |

## Docs

- User onboarding → root `README.md`
- Agent/CI contract → `docs/harness.md`
- Plans → `docs/plans/`

Keep `visual-qa --help` and README command tables in lockstep.

## PRs

- Prefer minimal diffs; no drive-by refactors with behavior changes.
- Add tests for verdict, exit code, or safety changes.
- Run `npm run verify` before push when browser paths change; `npm test` for
  pure unit edits.

## Security

Use GitHub security advisories for sensitive reports. Do not attach real app
secrets, session cookies, or customer PII to issues or evidence samples.
