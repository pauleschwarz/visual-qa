# visual-qa

**Autonomous QA for web apps: explore like a user, find what's broken, fix
what is mechanically fixable, prove every fix — and block the ship when
coverage or verdict fails.**

[![CI](https://github.com/pauleschwarz/visual-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/pauleschwarz/visual-qa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0f766e.svg)](LICENSE)

No human in the explore/fix/prove loop. Humans still own product judgment.

> **Install note:** the package name is `@pauleschwarz/visual-qa`. It is
> intended for npm, but if the registry package is missing, install from Git
> (see below). Always run `npx playwright install chromium` once per machine.

## Why not "just Playwright"?

| | Playwright / Cypress | **visual-qa** |
| --- | --- | --- |
| You write | Selectors + assertions | Bounds + optional intent |
| Exploration | Scripted paths | Bounded walk of the running app |
| Output | Pass/fail you defined | Findings + **verdict** + evidence dir |
| Autofix | You | Whitelisted mechanical fixes, proven |
| CI posture | Your suite | `junit`/`json` + non-zero on non-`PASS` |

**vs [pi-verity](https://github.com/pauleschwarz/pi-verity):** Verity proves
*repository* evidence after agent edits (tests, types, counterfactual).
**visual-qa** proves what a **browser** can observe on a running app. Use both.

## Quickstart

### From Git (always works)

```sh
git clone https://github.com/pauleschwarz/visual-qa.git
cd visual-qa
npm ci
npx playwright install chromium
npm link          # puts `visual-qa` on your PATH
visual-qa demo    # under a minute: bundled app with seeded defects
```

### From npm (when published)

```sh
npm install -g @pauleschwarz/visual-qa
npx playwright install chromium
visual-qa demo
```

The demo **finds everything wrong on purpose** — overflow, a crashing handler,
placeholder copy — so you see a real `FAIL` report with evidence, not a green
lie. Then point it at your app:

```sh
visual-qa run --url http://127.0.0.1:3000 --out .qa
open .qa/report.html   # portable inspection docket; no server required
```

Deterministic and offline by default. A full default walk is bounded at 40
states, 160 actions, and 15 minutes; start smaller with
`--max-states 8 --max-actions 24 --max-runtime-ms 60000` when learning the tool.

- `--format junit` → CI
- `--max-agent-calls N` → optional vision review (or your harness via
  `review-prepare` / `review-apply`)
- `--autofix verified --fix-dir ./app` → fix + prove title/lang/contrast
- `--intent 'ändere die Farbe von "Add item" auf grün'` → verified visual
  change (DE or EN)

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `PASS` | Explored completely, zero blocking findings |
| `FAIL` | Findings exist |
| `UNPROVEN` | Clean surface, but only low-severity notes — not a ship gate pass |
| `COVERAGE_INCOMPLETE` | Bounded budget stopped the walk — **never** a pass; raise bounds and re-run |

## Exit codes

| Code | When |
| --- | --- |
| `0` | Verdict `PASS` (exception: `visual-qa demo` exits `0` even with findings — fixture is defective on purpose) |
| `1` | Run finished; verdict is not `PASS` (findings or incomplete coverage) |
| `2` | Blocked (bad args, unreachable URL, refused mode) |

Every run writes three views: `report.html` for people, `report.md` for review,
and `report.json` for machines. Summarize the machine report with:

```sh
visual-qa report .qa --json
```

## Commands

```text
visual-qa demo [--out DIR] [bounds]
visual-qa run --url URL [--out DIR] [--isolated] [--autofix verified] [--fix-dir DIR]
              [--intent "…"] [--max-agent-calls N] [--mode off|changed|full] [bounds]
visual-qa explore --url URL [--out DIR] [bounds]     # deterministic core only
visual-qa report <DIR> [--json]                      # agent-friendly summary
visual-qa intent --intent "…" --fix-dir DIR [--json]  # catalog dry-run, no browser
visual-qa review-prepare <DIR> [--max-pairs N]       # export vision tasks for your model
visual-qa review-apply <DIR> <findings.json>         # apply harness findings (additive)
```

**Output (run/explore):** `--format human|json|junit`, `--out-file FILE` (junit).

**Mode:** `--mode off|changed|full` · `--changed-target URL` (repeatable;
required for `changed`) · `--baseline-dir DIR` · `--allow-destructive` (only
with `--isolated`).

**Bounds:** `--max-states N` · `--max-depth N` · `--max-actions N` ·
`--max-actions-per-state N` · `--max-runtime-ms N`.

Full agent contract: [`docs/harness.md`](docs/harness.md). Machine contract
(verdict policy, intent catalog, autofix whitelist):
[`schemas/intent-catalog.json`](schemas/intent-catalog.json).

## Agent loop (short)

1. Build or change the app; start it locally.
2. `visual-qa run --url … --out .qa` — add `--fix-dir` + `--autofix verified`
   and/or `--intent '…'` as needed.
3. `visual-qa report .qa --json` — each `issues[]` entry is a task; fix source,
   re-run until `PASS` or you consciously accept remaining findings.
4. Never ship on `COVERAGE_INCOMPLETE` — raise bounds, re-run.

Optional vision without baking a vendor into the CLI:

```sh
visual-qa review-prepare .qa
# hand images + prompts to your harness model → findings.json
visual-qa review-apply .qa findings.json
```

## Safety

- Destructive labels (delete, pay, unsubscribe, …) are **refused**; mutating
  labels require `--isolated`.
- External links are never followed; off-origin events are excluded.
- Secrets are redacted before evidence hits disk; reports are mode `0600`.
- Every patch leaves before/after copies under `<out>/fixes/` and
  `<out>/intent/`; every run has a `run_id`.

## Development

```sh
npm install && npx playwright install chromium
npm run verify      # unit + e2e against the seeded-defect fixture
npm run fixture     # serves the defect fixture (default :4173)
npm test            # unit tests only
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Docs index: [docs/README.md](docs/README.md).

## Related tools

| Tool | Layer |
| --- | --- |
| **visual-qa** (this) | Running web UI — explore / find / fix / prove |
| [pi-verity](https://github.com/pauleschwarz/pi-verity) | Repo evidence after coding-agent edits |
| [obsidian2date](https://github.com/pauleschwarz/obsidian2date) | Research window → Obsidian notes |

## License

MIT — [LICENSE](LICENSE).
