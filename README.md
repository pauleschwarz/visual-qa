# visual-qa

**Bounded browser QA for web apps:** explores a running app like a user,
reports findings with portable evidence, applies a small mechanical fix
whitelist when asked, and fails the ship gate when coverage or verdict is
not `PASS`.

Runs unattended. You still own the verdict and product judgment.

[![CI](https://github.com/pauleschwarz/visual-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/pauleschwarz/visual-qa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0f766e.svg)](LICENSE)

Status: **v0.2.0**. Not on npm yet — install from Git. **Chromium
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

**Known limits:** no authenticated areas — the explorer fills placeholder
test values, never real credentials, so login-gated pages are out of reach
(on purpose: wrong logins on a real app are mutating actions). Hover and
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
- `review-prepare` / `review-apply` → your harness vision model (human/agent
  in the loop for visual judgment)
- `--max-agent-calls N` → built-in vision (needs `VQA_VISION_*`)
- `--autofix verified --fix-dir ./app` → prove title/lang/contrast only
- `--intent 'ändere die Farbe von "Add item" auf grün'` → verified visual
  change (DE or EN)

## When not to use this

- You need multi-browser matrix (Firefox/WebKit) or device lab coverage.
- The app is behind auth and you have not supplied a session yet (v0.1 walks
  the public shell only).
- You want a replacement for unit/integration tests — this is a ship-gate
  on the running UI, not a test framework.
- Production traffic or real customer data (use `--isolated` only on safe
  fixtures).

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `PASS` | Explored completely, zero blocking findings, **and** vision review completed |
| `FAIL` | Findings exist |
| `UNPROVEN` | Clean surface, but only low-severity notes — not a ship gate pass |
| `COVERAGE_INCOMPLETE` | Bounded budget stopped the walk **or** vision review missing — **never** a pass |

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
              [--no-prepare-review] [--no-edge-input-probes]
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

**Review defaults (`run`):** auto-exports harness vision tasks after the walk
(`--no-prepare-review` to skip) · edge input probes on text fields
(`--no-edge-input-probes` to skip).

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
readability, slop, and consistency critics. Apply accepted findings, fix via the
repo workflow, then rerun until coverage is complete and the ship gate passes.
`DESIGN.md` is the project style authority; Impeccable and visual-qa complement
it with source-level and rendered-browser evidence.

Optional vision without baking a vendor into the CLI:

```sh
# after run, or re-export:
visual-qa review-prepare .qa
# hand images + system prompts to your model → findings.json
visual-qa review-apply .qa findings.json
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
