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

function portableEvidencePath(path) {
  const normalized = String(path ?? "").replaceAll("\\", "/");
  if (!normalized) return normalized;
  const marker = "/screenshots/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + 1);
  if (normalized.startsWith("screenshots/")) return normalized;
  if (normalized.startsWith("./")) return normalized.slice(2);
  return normalized;
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
  { maxPairs = 6, batchSize: batchSizeOpt } = {},
) {
  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  const actionPairs = evidence
    .map(screenshotPair)
    .filter(Boolean)
    .sort((left, right) => priority(left.entry) - priority(right.entry))
    .slice(0, Math.max(1, maxPairs));
  // Every unique state image is a page-level review target. Represent it as a
  // same-image pair so the existing reviewer/apply contract stays compatible;
  // maxPairs continues to bound action-transition pairs only.
  const seenStates = new Set();
  const statePairs = evidence
    .filter(
      (entry) =>
        (entry?.kind === "state_scan" || entry?.kind === "state_scroll_scan") &&
        entry.screenshot,
    )
    .filter((entry) => {
      const path = portableEvidencePath(entry.screenshot);
      if (!path || seenStates.has(path)) return false;
      seenStates.add(path);
      return true;
    })
    .map((entry) => ({
      entry,
      beforePath: entry.screenshot,
      afterPath: entry.screenshot,
    }));
  const pairs = [...statePairs, ...actionPairs];
  const requests = [];
  for (const { entry, beforePath, afterPath } of pairs) {
    for (const skill of Object.keys(SKILLS)) {
      requests.push({
        id: `${report.run_id || "run"}-${skill}-${slug(String(entry.action_id || entry.state_id || "unknown")).slice(0, 40)}`,
        skill,
        action_id: entry.action_id ?? null,
        state_id: entry.state_id ?? null,
        system: skillPrompt(skill),
        before: portableEvidencePath(beforePath),
        after: portableEvidencePath(afterPath),
        // The answering model may see the observation that triggered the pick.
        context: {
          kind: entry.kind || "action_pair",
          viewport: entry.viewport ?? null,
          status: entry.observation?.status ?? null,
          pixel_ratio: entry.observation?.pixel_ratio ?? null,
        },
      });
    }
  }
  const dir = reviewRequestsDir(outDir);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const batchesDir = join(dir, "batches");
  await mkdir(batchesDir, { recursive: true }).catch(() => {});

  // Default vision path: calling agent spawns short-lived reviewers (e.g.
  // smart subagents), one batch each — open, judge screenshots, close.
  // No API key required. Endpoint mode is optional.
  const batchSize = Math.max(
    1,
    Number(
      batchSizeOpt ?? process.env.VQA_VISION_BATCH_SIZE ?? 4,
    ) || 4,
  );
  const batches = chunkRequests(requests, batchSize).map((chunk, index) => {
    const id = `batch-${String(index + 1).padStart(2, "0")}`;
    const skills = [...new Set(chunk.map((r) => r.skill))];
    return {
      id,
      index: index + 1,
      skills,
      requests: chunk.map((request) => ({
        ...request,
        // Absolute paths help agent tools that cannot resolve relative out-dir.
        before_abs: join(outDir, request.before),
        after_abs: join(outDir, request.after),
      })),
    };
  });

  for (const batch of batches) {
    await writeFile(
      join(batchesDir, `${batch.id}.json`),
      `${JSON.stringify(
        {
          run_id: report.run_id || null,
          batch_id: batch.id,
          contract: SUBAGENT_BATCH_CONTRACT,
          requests: batch.requests,
        },
        null,
        2,
      )}\n`,
    );
  }

  const plan = {
    run_id: report.run_id || null,
    mode: "harness-subagent",
    out_dir: outDir,
    requests_file: "vision/requests.json",
    findings_file: "vision/findings.json",
    apply_command: `visual-qa review-apply ${outDir} ${join(outDir, "vision", "findings.json")}`,
    batch_size: batchSize,
    batch_count: batches.length,
    request_count: requests.length,
    skills: Object.keys(SKILLS),
    batches: batches.map((batch) => ({
      id: batch.id,
      file: `vision/batches/${batch.id}.json`,
      request_count: batch.requests.length,
      skills: batch.skills,
      model_hint: "same as caller (e.g. smart) or any multimodal reviewer",
    })),
    contract: HARNESS_PLAN_CONTRACT,
  };

  await writeFile(
    join(dir, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  await writeFile(join(dir, "plan.md"), renderHarnessPlanMarkdown(plan, outDir));

  const file = join(dir, "requests.json");
  await writeFile(
    file,
    `${JSON.stringify(
      {
        run_id: report.run_id || null,
        contract: HARNESS_PLAN_CONTRACT,
        plan_file: "vision/plan.md",
        batches_dir: "vision/batches",
        batch_count: batches.length,
        requests,
      },
      null,
      2,
    )}\n`,
  );
  return {
    dir,
    file,
    requests: requests.length,
    batches: batches.length,
    planFile: join(dir, "plan.md"),
  };
}

const HARNESS_PLAN_CONTRACT =
  "DEFAULT vision path (no API key): the agent that launched visual-qa spawns short-lived subagents (same model family, e.g. smart). Each subagent opens one vision/batches/batch-XX.json, reads before_abs/after_abs screenshots with vision, answers every request as {id, findings:[{title,severity,detail}]}, then exits. Parent merges all answers into vision/findings.json as {results:[...]} and runs visual-qa review-apply. Open → review → close. Optional endpoint mode (OPENAI_*/VQA_VISION_*) is only for unattended CI.";

const SUBAGENT_BATCH_CONTRACT =
  'You are a harsh direct-observer visual QA reviewer. For EACH request: load before_abs and after_abs images, obey the request.system prompt and skill focus, report only defects you can see. Reply with JSON only: {"results":[{"id":"<request.id>","skill":"<request.skill>","findings":[{"title":string,"severity":"high"|"medium"|"low","detail":string}]}]}. Empty findings only if the situation truly looks intentional and clean. Then exit.';

function chunkRequests(requests, size) {
  const out = [];
  for (let i = 0; i < requests.length; i += size) {
    out.push(requests.slice(i, i + size));
  }
  return out;
}

function renderHarnessPlanMarkdown(plan, outDir) {
  const lines = [
    `# visual-qa harness vision plan`,
    ``,
    `Mode: **harness-subagent** (default). No API key required.`,
    ``,
    `Out dir: \`${outDir}\``,
    `Requests: **${plan.request_count}** in **${plan.batch_count}** batches (size ${plan.batch_size}).`,
    `Skills: ${plan.skills.join(", ")}`,
    ``,
    `## Parent agent steps`,
    ``,
    `1. Spawn one short-lived subagent per batch below (model: same as you / smart).`,
    `2. Each child: open its batch JSON → vision-read screenshots → write findings for that batch → exit.`,
    `3. Merge every child \`results\` array into \`${plan.findings_file}\` as \`{"results":[...]}\`.`,
    `4. Run: \`${plan.apply_command}\``,
    `5. Read \`report.json\` verdict / \`coverage.vision_complete\`.`,
    ``,
    `## Batches`,
    ``,
  ];
  for (const batch of plan.batches) {
    lines.push(
      `- **${batch.id}** · ${batch.request_count} requests · skills: ${batch.skills.join(", ")} · \`${batch.file}\``,
    );
  }
  lines.push(
    ``,
    `## Child prompt (copy)`,
    ``,
    "```",
    SUBAGENT_BATCH_CONTRACT,
    "Batch file: <absolute path to batch-XX.json>",
    "Return only the JSON object with results for every request id in the batch.",
    "```",
    ``,
    plan.contract,
    ``,
  );
  return `${lines.join("\n")}\n`;
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
    if (acceptedHere === 0 && answer.findings.length === 0) {
      // Empty findings is a valid "looks clean" answer for this request id.
      // Do not reject — otherwise harness subagents cannot close vision.
    }
  }

  // Drop the fail-closed gap finding once harness vision answers land.
  const priorIssues = (report.issues || []).filter(
    (issue) => issue?.issue_id !== "vqa-vision-required-unavailable",
  );
  report.issues = dedupeIssues([...priorIssues, ...accepted]);

  // vision_complete when at least one request id was answered (findings may be empty).
  const visionComplete =
    appliedIds.size > 0 &&
    !report.issues.some((i) => i.issue_id === "vqa-vision-required-unavailable");

  const limited = report.coverage?.limit_reason != null;
  const explorerComplete =
    !limited && Number(report.coverage?.states || report.states?.length || 0) > 0;
  // Walk may still be incomplete due to bounds; vision can complete independently.
  const complete = explorerComplete && visionComplete;

  report.coverage = {
    ...(report.coverage || {}),
    vision_required: true,
    vision_complete: visionComplete,
    vision_status: visionComplete
      ? "harness_applied"
      : report.coverage?.vision_status || "harness_pending",
  };
  report.complete = complete;
  report.verdict = verdictFor({ issues: report.issues, complete });

  report.phases = report.phases || {};
  report.phases.harness_vision = {
    status: "applied",
    applied: [...appliedIds],
    accepted: accepted.length,
    rejected: rejected.length,
    vision_complete: visionComplete,
  };
  if (visionComplete && report.phases.vision) {
    report.phases.vision = {
      ...report.phases.vision,
      status: "harness_applied",
      completed: Math.max(
        Number(report.phases.vision.completed || 0),
        appliedIds.size,
      ),
    };
  }
  await writeReportArtifacts(outDir, report);
  const blocking = rejected.filter(
    (entry) => entry.reason !== "already_applied",
  );
  return {
    verdict: report.verdict,
    accepted: accepted.length,
    rejected: rejected.length,
    issues: report.issues.length,
    vision_complete: visionComplete,
    complete,
    ok: blocking.length === 0,
  };
}
