// Visual QA - orchestrated run pipeline.
//
// explore() stays the deterministic core. run() is the full product: explore,
// vision review (additive only), verified autofix, and aggregation into
// report.json + report.md with one final verdict.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redact, resolveConfig } from "./config.mjs";
import { dedupeIssues, verdictFor } from "./checks.mjs";
import { explore } from "./explore.mjs";
import { applyFixes, collectFixes, diffIssues } from "./fix.mjs";
import { applyIntent, parseIntent } from "./intent.mjs";
import { renderMarkdownReport } from "./report.mjs";
import { runVisionReview } from "./vision.mjs";

export async function run(input = {}) {
  const config = resolveConfig(input);
  if (!config.baseUrl && config.mode !== "off")
    throw new Error("Visual QA requires baseUrl");
  const outDir = config.outDir;
  const runId = randomUUID().slice(0, 8);
  await mkdir(outDir, { recursive: true });

  // An unparsed intent must stay visible: the instruction was heard but not
  // understood, and pretending otherwise would break traceability.
  const intent = input.intent ? parseIntent(input.intent) : null;
  const intentChecks =
    input.intentChecks ?? (intent ? [intent] : []);

  // Phase 1: deterministic exploration (a11y, layout, runtime, slop,
  // security, intent baseline).
  const report = await explore({ ...input, intentChecks });
  const phases = { run_id: runId };

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

  // Phase 3: verified source changes. Whitelisted autofixes and explicit
  // intents both patch fixDir sources; ONE fresh exploration then verifies
  // everything against computed styles and fresh findings.
  let verify = null;
  if (input.intent && !intent)
    phases.intent = {
      parsed: false,
      detail: "Intent instruction was not understood; nothing applied.",
    };
  if (intent && config.fixDir) {
    const result = await applyIntent(intent, config.fixDir, join(outDir, "intent"));
    phases.intent = { parsed: true, ...result };
  } else if (intent && !config.fixDir) {
    phases.intent = { parsed: true, applied: false, reason: "no_fix_dir" };
  }
  const pendingFixes =
    report.verdict !== "PASS" && config.autofix === "verified" && config.fixDir
      ? collectFixes(report.issues)
      : [];
  if (pendingFixes.length) {
    const { applied, skipped } = await applyFixes(
      pendingFixes,
      config.fixDir,
      join(outDir, "fixes"),
    );
    phases.fix = { applied, skipped };
  }
  if ((pendingFixes.length || phases.intent?.applied) && config.fixDir) {
    verify = await explore({
      ...input,
      intentChecks,
      outDir: join(outDir, "verify"),
    });
    const diff = diffIssues(report.issues, verify.issues);
    phases.verify = {
      verdict: verify.verdict,
      complete: verify.complete,
      fixed: diff.fixed.length,
      remaining: diff.remaining.length,
    };
  }

  // Aggregate: the authoritative run is the latest COMPLETE deterministic run.
  // An incomplete verify run cannot prove a fix, so the original run stays
  // authoritative in that case. Vision findings are always additive.
  const authoritative = verify?.complete ? verify : report;
  const issues = dedupeIssues([...authoritative.issues, ...visionIssues]);
  const verdict = verdictFor({ issues, complete: authoritative.complete });

  const result = {
    ...report,
    run_id: runId,
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
