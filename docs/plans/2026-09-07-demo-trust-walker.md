# Plan: Demo trust + walker honesty (Ticket 1)

## Goal

Make first-run trust true: demo finishes as FAIL under a minute, bounds hold,
README stops over-claiming, CI asserts demo timing, walker stops wasting time
on blind restores and silent popup/dialog misses.

## Non-goals

- No storageState / route / form-contract / multi-browser yet (Ticket 2+).
- No npm publish.
- No autofix expansion.
- No push/PR without human gate.

## Acceptance

1. Default `visual-qa demo` returns terminal verdict `FAIL` (not `COVERAGE_INCOMPLETE`), finds seeded defects, wall clock < 90s locally and < 120s in CI.
2. Demo bounds are coherent with measured cost and comments match code.
3. README: drop "Autonomous" / "No human in the loop"; Git-only install; Chromium-only; measured demo time; expected FAIL; status v0.1.0 pre-release.
4. `BrowserRuntime` records dialogs (auto-dismiss + evidence) and new pages/popups (attach listeners); no silent hang on `confirm()`.
5. `click` timeout adaptive/shorter (not fixed 5s stability tax); `restoreState` skips navigate when already on target URL.
6. Report HTML finding card shows selector/repro summary outside collapsed JSON when evidence has them.
7. CI runs a bounded demo timing assertion.
8. `npm run verify` green.

## Tasks

### A. Demo bounds + exit contract

Files: `src/demo.mjs`, `bin/visual-qa.mjs`, `test/demo-report.test.mjs`

- Tighten DEMO_BOUNDS so default walk completes the fixture graph:
  - max_states: 12
  - max_depth: 3
  - max_actions_per_state: 8
  - max_total_actions: 40
  - max_runtime_ms: 90_000
- Comment must say complete FAIL walk, not coverage warning.
- Keep demo exit 0 when not blocked (findings expected) — already true.
- Test: default-ish bounds still get FAIL + >=3 issues + duration_ms < 90_000 on the unit/selftest path (selftest may keep smaller overrides; add one timing-aware check or CI script).

### B. Walker perf/correctness

Files: `src/browser.mjs`, `src/explore.mjs`, tests

1. `restoreState`: if `page.url()` already matches target (normalize), skip `navigate`.
2. `click`: lower default action timeout to 2000; keep `waitForStableState` after.
3. Dialogs: in `#attachListeners`, `page.on('dialog', d => { record; dismiss })`.
4. Popups: `context.on('page', p => attachListeners(p); track)`.
5. Surface dialogs/popups counts in `markStep` event delta if cheap.
6. explore loop: before `restoreOrIssue`, if live URL already equals queued URL and theme matches, skip restore.

### C. Report finding cards

Files: `src/report.mjs`, `test/demo-report.test.mjs` or unit

- For each issue, render a one-line "Where" from evidence.selector / evidence.nodes[0].target / evidence.control (role+name) / evidence.url.
- Keep JSON details.

### D. README honesty

File: `README.md`

Rewrite per audit outline:

- Honest one-liner (bounded, unattended, evidence, fail-closed).
- Status box: v0.1.0, not on npm, Chromium only, Node >=20, macOS/Linux tested.
- Single install path from Git.
- `visual-qa demo` comment: measured ~1 min on Apple Silicon; expect FAIL with seeded defects.
- Human owns verdict; review-prepare/apply is the vision HITL path.
- When NOT to use.
- Drop npm section until publish.
- Soften comparison table; disclose Chromium-only.

### E. CI timing gate

File: `.github/workflows/ci.yml`

After verify:

```sh
node bin/visual-qa.mjs demo --out /tmp/vqa-ci-demo --max-runtime-ms 90000
# assert report.json verdict is FAIL and duration_ms < 120000
```

Use node one-liner to read report.json.

## Proof

```sh
npm test
npm run selftest
npm run verify
/usr/bin/time -p node bin/visual-qa.mjs demo --out /tmp/vqa-ticket1-demo
node -e 'const r=require("/tmp/vqa-ticket1-demo/report.json"); if(r.verdict!=="FAIL") process.exit(1); if(r.duration_ms>90000) process.exit(2); console.log(r.verdict,r.duration_ms,r.issues.length)'
```

## DONE WHEN

- All acceptance items true.
- Diff limited to listed files (+ new tiny test if needed).
- No push.
