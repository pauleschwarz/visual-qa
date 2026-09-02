# Plan: New-user trust and product polish

## Goal

Make the first internet-user experience truthful, actionable, and recognizably
visual-qa without weakening the verdict contract.

## Vertical slices

### 1. Trustworthy install and public contract

Acceptance:

- Help is discoverable with exit 0; invalid arguments remain exit 2.
- Documented package exports exist.
- The public tarball excludes internal plans and runtime dependencies exclude dev-only pi-verity.

Checks:

```sh
node bin/visual-qa.mjs --help >/tmp/vqa-help.txt
node --input-type=module -e 'import { dryRunIntent, summarizeReport } from "./src/index.mjs"'
npm pack --dry-run --json
```

### 2. Honest first run and CLI failure guidance

Acceptance:

- Missing option values, invalid URLs, unsupported formats, and unsafe destructive mode fail before browser work.
- A total browser startup failure exits 2, not as an ordinary finding-only run.
- Demo and explore create every artifact advertised by the CLI.

Checks:

```sh
node --test test/cli.test.mjs test/demo-report.test.mjs
node bin/visual-qa.mjs explore --url not-a-url --out /tmp/vqa-invalid
```

### 3. Portable report with product identity

Acceptance:

- Every run writes `report.json`, `report.md`, and a self-contained `report.html`.
- Critical/high findings are prioritized in summaries regardless of input order.
- HTML remains readable at mobile width, uses one accent, no external assets, and includes evidence plus Paul Schwarz attribution.

Checks:

```sh
npm run selftest
node --test test/demo-report.test.mjs
```

## Final gate

```sh
npm run verify
npm pack --dry-run --json
```
