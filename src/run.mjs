// Visual QA - orchestrated run pipeline.
//
// explore() stays the deterministic core. run() is the full product: explore,
// vision review (additive only), verified autofix, and aggregation into
// report.json + report.md with one final verdict.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redact, resolveConfig } from "./config.mjs";
import { dedupeIssues, verdictFor } from "./checks.mjs";
import { explore } from "./explore.mjs";
import { applyFixes, collectFixes, diffIssues } from "./fix.mjs";
import { renderMarkdownReport } from "./report.mjs";
import { runVisionReview } from "./vision.mjs";

export async function run(input = {}) {
  const config = resolveConfig(input);
  if (!config.baseUrl) throw new Error("Visual QA requires baseUrl");
  const outDir = config.outDir;
  await mkdir(outDir, { recursive: true });

  // Phase 1: deterministic exploration (a11y, layout, runtime, slop, security).
  const report = await explore(input);
  const phases = {};

  // Phase 2: vision review. Additive by contract: findings can extend the
  // report, never remove or downgrade deterministic results, and severity is
  // capped at medium so vision alone cannot flip a verdict to FAIL.
  let visionIssues = [];
  try {
    const vision = await runVisionReview({ report, config });
    visionIssues = vision.issues || [];
    phases.vision = {
      status: vision.status,
      attempted: vision.attempted ?? 0,
      completed: vision.completed ?? 0,
      issues: visionIssues.length,
    };
  } catch (error) {
    // A broken vision endpoint degrades the review, never the run.
    phases.vision = { status: `error: ${error.message}`, issues: 0 };
  }

  // Phase 3: verified autofix on whitelisted document defects. Only runs on a
  // failed report, only with an explicit fixDir, and only re-verdicts when a
  // complete fresh exploration clears the issues.
  let verify = null;
  if (
    report.verdict !== "PASS" &&
    config.autofix === "verified" &&
    config.fixDir
  ) {
    const fixes = collectFixes(report.issues);
    const { applied, skipped } = await applyFixes(fixes, config.fixDir);
    phases.fix = { applied, skipped };
    if (applied.length) {
      verify = await explore({ ...input, outDir: join(outDir, "verify") });
      const diff = diffIssues(report.issues, verify.issues);
      phases.verify = {
        verdict: verify.verdict,
        complete: verify.complete,
        fixed: diff.fixed.length,
        remaining: diff.remaining.length,
      };
    }
  }

  // Aggregate: the authoritative run is the latest COMPLETE deterministic run.
  // An incomplete verify run cannot prove a fix, so the original run stays
  // authoritative in that case. Vision findings are always additive.
  const authoritative = verify?.complete ? verify : report;
  const issues = dedupeIssues([...authoritative.issues, ...visionIssues]);
  const verdict = verdictFor({ issues, complete: authoritative.complete });

  const result = {
    ...report,
    verdict,
    complete: authoritative.complete,
    coverage: authoritative.coverage,
    issues,
    evidence: authoritative.evidence,
    states: authoritative.states ?? report.states,
    edges: authoritative.edges ?? report.edges,
    phases,
  };

  await writeFile(
    join(outDir, "report.json"),
    `${JSON.stringify(redact(result), null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(outDir, "report.md"),
    `${renderMarkdownReport(result)}\n`,
    { mode: 0o600 },
  );
  return result;
}
