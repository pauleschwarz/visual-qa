// Visual QA - orchestrated run pipeline.
//
// explore() stays the deterministic core. run() is the full product: explore,
// vision review (additive only), verified autofix, and aggregation into
// report.json + report.md with one final verdict.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveConfig, redact } from "./config.mjs";
import { dedupeIssues, verdictFor } from "./checks.mjs";
import { explore } from "./explore.mjs";
import { applyFixes, collectFixes, diffIssues } from "./fix.mjs";
import { applyIntent, parseIntent } from "./intent.mjs";
import { writeReportArtifacts } from "./report.mjs";
import { prepareHarnessReview, reviewRequestsDir } from "./review.mjs";
import { runVisionReview } from "./vision.mjs";

function reviewDirFallback(outDir) {
  try {
    return reviewRequestsDir(outDir);
  } catch {
    return null;
  }
}

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
  const intentChecks = input.intentChecks ?? (intent ? [intent] : []);

  // Phase 1: deterministic exploration (a11y, layout, runtime, slop,
  // security, intent baseline).
  const report = await explore({
    ...input,
    visionEvidence: true,
    intentChecks,
  });
  const phases = { run_id: runId };

  // Phase 2: vision review. Additive by contract: findings can extend the
  // report, never remove or downgrade deterministic results, and severity is
  // capped at medium so vision alone cannot flip a verdict to FAIL.
  //
  // Vision is REQUIRED for a complete ship gate. Skipping because no key /
  // no calls / no pairs / endpoint error marks coverage incomplete and emits
  // an explicit high finding — silent "looks green without eyes" is forbidden.
  let visionIssues = [];
  let visionCoverageGap = false;
  try {
    const vision = await runVisionReview({ report, config });
    visionIssues = vision.issues || [];
    phases.vision = {
      status: vision.status,
      attempted: vision.attempted ?? 0,
      completed: vision.completed ?? 0,
      issues: visionIssues.length,
    };
    const status = String(vision.status || "");
    if (
      status.startsWith("skipped_") ||
      status.startsWith("error") ||
      (Number(vision.attempted || 0) === 0 &&
        Number(config?.bounds?.max_agent_calls || 0) < 1)
    ) {
      visionCoverageGap = true;
      visionIssues = dedupeIssues([
        ...visionIssues,
        {
          issue_id: "vqa-vision-required-unavailable",
          type: "vqa-vision",
          title: "Vision review unavailable",
          severity: "high",
          detail:
            "No vision model completed a review for this run. Layout/slop defects that only a model can see are unproven. Provide a vision endpoint (VQA_VISION_*) or complete harness review-apply, or pass prepareReview with applied answers.",
          evidence: redact({
            status: vision.status,
            attempted: vision.attempted ?? 0,
            completed: vision.completed ?? 0,
            max_agent_calls: config?.bounds?.max_agent_calls ?? 0,
            hint: "set VQA_VISION_API_KEY + max_agent_calls>0, or finish harness review",
          }),
        },
      ]);
    }
  } catch (error) {
    visionCoverageGap = true;
    phases.vision = { status: `error: ${error.message}`, issues: 0 };
    visionIssues = [
      {
        issue_id: "vqa-vision-required-unavailable",
        type: "vqa-vision",
        title: "Vision review unavailable",
        severity: "high",
        detail: `Vision review threw: ${error.message}`,
        evidence: redact({ error: String(error.message || error) }),
      },
    ];
  }

  // Phase 3: verified source changes. Whitelisted autofixes and explicit
  // intents both patch fixDir sources; ONE fresh exploration then verifies
  // everything against computed styles and fresh findings.
  let verify = null;
  if (input.intent && !intent) {
    phases.intent = {
      parsed: false,
      detail: "Intent instruction was not understood; nothing applied.",
    };
    report.issues = dedupeIssues([
      ...(report.issues || []),
      {
        issue_id: "vqa-intent-unparsed",
        type: "vqa-intent",
        title: "Intent instruction not understood",
        severity: "high",
        detail: phases.intent.detail,
        evidence: redact({ intent: String(input.intent).slice(0, 240) }),
      },
    ]);
    report.verdict = verdictFor({
      issues: report.issues,
      complete: report.complete,
    });
  }
  if (intent && config.fixDir) {
    const result = await applyIntent(
      intent,
      config.fixDir,
      join(outDir, "intent"),
    );
    phases.intent = { parsed: true, ...result };
  } else if (intent && !config.fixDir) {
    phases.intent = { parsed: true, applied: false, reason: "no_fix_dir" };
    report.issues = dedupeIssues([
      ...(report.issues || []),
      {
        issue_id: "vqa-intent-no-fix-dir",
        type: "vqa-intent",
        title: "Intent requires --fix-dir",
        severity: "high",
        detail:
          "Parsed intent was not applied because no fix directory was provided.",
        evidence: redact({ intent: String(input.intent).slice(0, 240) }),
      },
    ]);
    report.verdict = verdictFor({
      issues: report.issues,
      complete: report.complete,
    });
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
  const deterministicIssues = verify?.complete
    ? verify.issues
    : verify
      ? dedupeIssues([
          ...report.issues.filter((issue) =>
            verify.issues.some(
              (candidate) => candidate.issue_id === issue.issue_id,
            ),
          ),
          ...verify.issues,
        ])
      : report.issues;
  const issues = dedupeIssues([...deterministicIssues, ...visionIssues]);
  const complete = Boolean(authoritative.complete) && !visionCoverageGap;
  const verdict = verdictFor({ issues, complete });

  const result = {
    ...report,
    run_id: runId,
    verdict,
    complete,
    coverage: {
      ...(authoritative.coverage || report.coverage || {}),
      vision_required: true,
      vision_complete: !visionCoverageGap,
      vision_status: phases.vision?.status ?? null,
    },
    issues,
    evidence: authoritative.evidence,
    states: authoritative.states ?? report.states,
    edges: authoritative.edges ?? report.edges,
    phases,
  };

  await writeReportArtifacts(outDir, result);

  // Export harness vision tasks by default so an agent never has to remember
  // `review-prepare`. Opt out with prepareReview: false / --no-prepare-review.
  if (config.prepareReview !== false) {
    try {
      const prepared = await prepareHarnessReview(result, outDir, {
        maxPairs: Number.isInteger(input.reviewMaxPairs)
          ? input.reviewMaxPairs
          : 6,
      });
      phases.harness_review = {
        status: "prepared",
        requests: Array.isArray(prepared?.requests)
          ? prepared.requests.length
          : (prepared?.count ?? null),
        dir: prepared?.dir ?? reviewDirFallback(outDir),
      };
      result.phases = { ...result.phases, ...phases };
      await writeReportArtifacts(outDir, result);
    } catch (error) {
      phases.harness_review = {
        status: `error: ${error.message}`,
      };
      result.phases = { ...result.phases, ...phases };
      await writeReportArtifacts(outDir, result);
    }
  }

  return result;
}
