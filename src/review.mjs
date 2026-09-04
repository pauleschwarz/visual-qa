// Visual QA - harness-driven vision review.
//
// Option B of the vision contract: instead of the runtime calling an
// endpoint with its own key, the calling harness's own vision model does
// the review. prepare exports the review tasks (screenshot pairs x skill
// prompts); apply validates the returned findings with the SAME additive
// rules as the internal mode - capped severity, never removed or
// downgraded deterministic findings, request-id matching for
// traceability.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dedupeIssues, verdictFor } from "./checks.mjs";
import { redact } from "./config.mjs";
import { writeReportArtifacts } from "./report.mjs";
import { skillPrompt, SKILLS } from "./vision.mjs";

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} at ${path}: ${error.message}`);
  }
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function screenshotPair(entry) {
  const beforePath = entry?.before?.screenshot;
  const afterPath = entry?.after?.screenshot;
  if (!beforePath || !afterPath) return null;
  return { entry, beforePath, afterPath };
}

function priority({ observation } = {}) {
  if (observation?.status === "error") return 0;
  if (observation?.pixel_ratio > 0.2) return 1;
  return 2;
}

export function reviewRequestsDir(outDir) {
  return join(outDir, "vision");
}

/**
 * Build the review task file for a finished run: one request per
 * screenshot pair x skill, capped at maxPairs pairs (priority-ordered).
 * The harness hands each request's images and system prompt to its own
 * vision model and collects { id, findings } answers.
 */
export async function prepareHarnessReview(
  report,
  outDir,
  { maxPairs = 6 } = {},
) {
  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  const pairs = evidence
    .map(screenshotPair)
    .filter(Boolean)
    .sort((left, right) => priority(left.entry) - priority(right.entry))
    .slice(0, Math.max(1, maxPairs));
  const requests = [];
  for (const { entry, beforePath, afterPath } of pairs) {
    for (const skill of Object.keys(SKILLS)) {
      requests.push({
        id: `${report.run_id || "run"}-${skill}-${slug(String(entry.action_id || "unknown")).slice(0, 40)}`,
        skill,
        action_id: entry.action_id ?? null,
        system: skillPrompt(skill),
        before: beforePath,
        after: afterPath,
        // The answering model may see the observation that triggered the pick.
        context: {
          status: entry.observation?.status ?? null,
          pixel_ratio: entry.observation?.pixel_ratio ?? null,
        },
      });
    }
  }
  const dir = reviewRequestsDir(outDir);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const file = join(dir, "requests.json");
  await writeFile(
    file,
    `${JSON.stringify(
      {
        run_id: report.run_id || null,
        contract:
          'Answer each request with your own vision model as {"id": string, "findings": [{"title": string, "severity": "high"|"medium"|"low", "detail": string}]}. Collect all answers into one JSON file {"results": [...]} and run: visual-qa review-apply <dir> <findings.json>',
        requests,
      },
      null,
      2,
    )}\n`,
  );
  return { file, requests: requests.length };
}

function toVisionIssue(answer, finding, index) {
  // The additive-only cap: harness findings may ADD to a report, never
  // flip a verdict to FAIL by themselves.
  const severity = finding.severity === "high" ? "medium" : finding.severity;
  return {
    issue_id: `vqa-vision-${index}-${slug(finding.title)}`,
    type: "vqa-vision",
    title: finding.title,
    severity,
    detail: finding.detail,
    evidence: redact({
      source: "harness-vision",
      skill: answer.skill,
      action_id: answer.action_id,
      request_id: answer.id,
    }),
  };
}

/**
 * Apply harness answers to a report: validate shape, match request ids,
 * cap severity, append to issues, recompute the verdict, and rewrite
 * report.json/report.md. Applying the same answers twice is a no-op (the
 * applied request ids are recorded), so a retry cannot duplicate findings.
 */
export async function applyHarnessReview(outDir, findingsFile) {
  const reportPath = join(outDir, "report.json");
  const report = await readJson(reportPath, "visual-qa report");
  const answers = await readJson(findingsFile, "vision findings");
  const results = Array.isArray(answers?.results) ? answers.results : [];
  if (!Array.isArray(answers?.results))
    throw new Error(
      'findings file must be {"results": [{"id", "findings": [...]}]}',
    );

  const appliedIds = new Set(report.phases?.harness_vision?.applied ?? []);
  const accepted = [];
  const rejected = [];
  for (const result of results) {
    const answer = {
      id: String(result?.id ?? ""),
      skill: String(result?.skill ?? "unknown"),
      action_id: result?.action_id ?? null,
      findings: Array.isArray(result?.findings) ? result.findings : [],
    };
    if (!answer.id) {
      rejected.push({ id: "", reason: "missing_id" });
      continue;
    }
    if (appliedIds.has(answer.id)) {
      rejected.push({ id: answer.id, reason: "already_applied" });
      continue;
    }
    let acceptedHere = 0;
    for (const finding of answer.findings) {
      if (
        !finding ||
        typeof finding !== "object" ||
        typeof finding.title !== "string" ||
        typeof finding.detail !== "string" ||
        !["high", "medium", "low"].includes(finding.severity)
      ) {
        rejected.push({ id: answer.id, reason: "invalid_finding" });
        continue;
      }
      accepted.push(
        toVisionIssue(
          { ...answer, skill: result.skill ?? answer.skill },
          finding,
          accepted.length,
        ),
      );
      acceptedHere += 1;
    }
    appliedIds.add(answer.id);
    if (acceptedHere === 0 && answer.findings.length === 0)
      rejected.push({ id: answer.id, reason: "empty_findings" });
  }

  if (accepted.length) {
    report.issues = dedupeIssues([...(report.issues || []), ...accepted]);
    report.verdict = verdictFor({
      issues: report.issues,
      complete: report.complete,
    });
  }
  report.phases = report.phases || {};
  report.phases.harness_vision = {
    status: "applied",
    applied: [...appliedIds],
    accepted: accepted.length,
    rejected: rejected.length,
  };
  await writeReportArtifacts(outDir, report);
  return {
    verdict: report.verdict,
    accepted: accepted.length,
    rejected: rejected.length,
    issues: report.issues.length,
  };
}
