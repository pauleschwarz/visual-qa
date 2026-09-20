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

const SKILL_KEYS = new Set(Object.keys(SKILLS));

/** Default agent-loop pack: full visual taste + DESIGN.md preservation. */
export const HARNESS_LOOP_SKILLS = [
  "layout",
  "readability",
  "color",
  "slop",
  "consistency",
  "preservation",
];

function resolveReviewSkills(skillsOpt) {
  if (skillsOpt == null) return Object.keys(SKILLS);
  const raw = Array.isArray(skillsOpt)
    ? skillsOpt
    : String(skillsOpt)
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
  if (raw.length === 1 && raw[0] === "loop") return [...HARNESS_LOOP_SKILLS];
  if (raw.length === 1 && raw[0] === "all") return Object.keys(SKILLS);
  const out = [];
  const seen = new Set();
  for (const key of raw) {
    if (!SKILL_KEYS.has(key))
      throw new Error(
        `Unknown review skill "${key}"; expected one of ${[...SKILL_KEYS].join(", ")}, loop, or all`,
      );
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  if (!out.length) throw new Error("review skills list is empty");
  return out;
}


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
 * screenshot pair × skill.
 *
 * Bounds (agent-loop defaults):
 * - maxPairs: action before/after pairs (priority-ordered)
 * - maxStatePairs: unique state_scan images (was unbounded → 50+ batches)
 * - skills: subset of SKILLS keys; default all. Agent loops should pass a
 *   short pack (layout, readability, slop, preservation).
 * The harness hands each request's images and system prompt to its own
 * vision model and collects { id, findings } answers.
 */
export async function prepareHarnessReview(
  report,
  outDir,
  {
    maxPairs = 6,
    maxStatePairs = 4,
    batchSize: batchSizeOpt,
    skills: skillsOpt = null,
    designContract = null,
  } = {},
) {
  const contract =
    designContract ??
    report?.design_contract_content ??
    (report?.design_contract?.content ? report.design_contract : null);
  // Prefer full content object {path,sha256,content}; meta-only is not enough for prompts.
  const designForPrompt =
    contract && typeof contract === "object" && contract.content
      ? contract
      : null;
  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  const actionPairs = evidence
    .map(screenshotPair)
    .filter(Boolean)
    .sort((left, right) => priority(left.entry) - priority(right.entry))
    .slice(0, Math.max(1, maxPairs));
  // Unique state images are page-level review targets (same-image pairs so the
  // reviewer/apply contract stays compatible). Cap them — unbounded state walks
  // × every skill produced 50+ batches and agents never finished review-apply.
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
    }))
    .slice(0, Math.max(0, Number(maxStatePairs) || 0));
  const pairs = [...statePairs, ...actionPairs];
  const skillKeys = resolveReviewSkills(skillsOpt);
  const requests = [];
  for (const [pairIndex, { entry, beforePath, afterPath }] of pairs.entries()) {
    const pairIdentity = String(
      entry.action_id ||
        entry.state_id ||
        entry.screenshot ||
        afterPath ||
        beforePath ||
        "unknown",
    );
    for (const skill of skillKeys) {
      // Slugs are intentionally truncated for readable artifacts, so include the
      // deterministic pair index. State ids may share the same first 40 chars.
      requests.push({
        id: `${report.run_id || "run"}-${skill}-${slug(pairIdentity).slice(0, 40)}-${pairIndex}`,
        skill,
        action_id: entry.action_id ?? null,
        state_id: entry.state_id ?? null,
        system: skillPrompt(skill, { designContract: designForPrompt }),
        before: portableEvidencePath(beforePath),
        after: portableEvidencePath(afterPath),
        // The answering model may see the observation that triggered the pick.
        context: {
          kind: entry.kind || "action_pair",
          viewport: entry.viewport ?? null,
          status: entry.observation?.status ?? null,
          pixel_ratio: entry.observation?.pixel_ratio ?? null,
          design_contract_sha256:
            designForPrompt?.sha256 ?? report?.design_contract?.sha256 ?? null,
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
    `Hard rule: finish every batch → merge findings.json → review-apply before claiming vision done.`,
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
 * Load planned request IDs from vision/requests.json (authoritative plan).
 */
export async function loadPlannedRequestIds(outDir) {
  const path = join(reviewRequestsDir(outDir), "requests.json");
  const planned = await readJson(path, "vision requests plan");
  const requests = Array.isArray(planned?.requests) ? planned.requests : [];
  const byId = new Map();
  for (const request of requests) {
    const id = String(request?.id ?? "").trim();
    if (!id) continue;
    byId.set(id, {
      id,
      skill: request.skill != null ? String(request.skill) : null,
    });
  }
  return { path, byId, ids: [...byId.keys()] };
}

/**
 * Fail-closed coverage: every planned request ID must appear exactly once
 * among valid accepted answers. Unknown/duplicate/malformed/skill-mismatch
 * or missing IDs keep vision incomplete.
 */
export function evaluateVisionCoverage({
  requiredIds = [],
  plannedById = new Map(),
  results = [],
  previouslyApplied = [],
} = {}) {
  const required = [...new Set(requiredIds.map(String))];
  const requiredSet = new Set(required);
  const answered = new Set(
    (previouslyApplied || []).map(String).filter((id) => requiredSet.has(id)),
  );
  const invalid = [];
  const seenInBatch = new Set();
  const validNew = [];

  for (const result of results) {
    const id = String(result?.id ?? "").trim();
    if (!id) {
      invalid.push({ id: "", reason: "missing_id" });
      continue;
    }
    if (!requiredSet.has(id)) {
      invalid.push({ id, reason: "unknown_id" });
      continue;
    }
    if (seenInBatch.has(id) || answered.has(id)) {
      invalid.push({ id, reason: "duplicate_id" });
      continue;
    }
    seenInBatch.add(id);

    if (!Array.isArray(result?.findings)) {
      invalid.push({ id, reason: "malformed_findings" });
      continue;
    }

    const planned = plannedById.get(id);
    const skill =
      result?.skill != null && String(result.skill).trim()
        ? String(result.skill).trim()
        : planned?.skill ?? null;
    if (skill && !SKILL_KEYS.has(skill)) {
      invalid.push({ id, reason: "unknown_skill", skill });
      continue;
    }
    if (planned?.skill && skill && skill !== planned.skill) {
      invalid.push({
        id,
        reason: "skill_mismatch",
        expected: planned.skill,
        skill,
      });
      continue;
    }

    let findingsOk = true;
    for (const finding of result.findings) {
      if (
        !finding ||
        typeof finding !== "object" ||
        typeof finding.title !== "string" ||
        typeof finding.detail !== "string" ||
        !["high", "medium", "low"].includes(finding.severity)
      ) {
        findingsOk = false;
        break;
      }
    }
    if (!findingsOk) {
      invalid.push({ id, reason: "invalid_finding" });
      continue;
    }

    // Empty findings = valid clean answer.
    validNew.push({
      id,
      skill: skill || planned?.skill || "unknown",
      action_id: result?.action_id ?? null,
      findings: result.findings,
    });
    answered.add(id);
  }

  const missing = required.filter((id) => !answered.has(id));
  const complete =
    required.length > 0 &&
    missing.length === 0 &&
    invalid.filter((e) => e.reason !== "duplicate_id" || !answered.has(e.id))
      .length === 0 &&
    // Any invalid answer that is not a pure duplicate of an already-valid id blocks completeness.
    invalid.every(
      (e) => e.reason === "duplicate_id" && answered.has(e.id),
    );

  // Stricter: any unknown/malformed/skill issue keeps incomplete.
  const blockingInvalid = invalid.filter((e) => e.reason !== "duplicate_id");
  const visionComplete =
    required.length > 0 &&
    missing.length === 0 &&
    blockingInvalid.length === 0;

  return {
    required,
    answered: [...answered],
    missing,
    invalid,
    validNew,
    vision_complete: visionComplete,
  };
}

/**
 * Apply harness answers to a report: validate shape, match request ids,
 * require full plan coverage, cap severity, append issues, rewrite artifacts.
 * Partial batches stay incomplete until every planned ID has a valid answer.
 * Idempotent for already-applied IDs.
 */
export async function applyHarnessReview(outDir, findingsFile) {
  const reportPath = join(outDir, "report.json");
  const report = await readJson(reportPath, "visual-qa report");
  const answers = await readJson(findingsFile, "vision findings");
  if (!Array.isArray(answers?.results))
    throw new Error(
      'findings file must be {"results": [{"id", "findings": [...]}]}',
    );
  const results = answers.results;

  const { byId: plannedById, ids: requiredIds } =
    await loadPlannedRequestIds(outDir);
  if (!requiredIds.length) {
    throw new Error(
      `No planned vision requests at ${join(reviewRequestsDir(outDir), "requests.json")}; run review-prepare first`,
    );
  }

  const previouslyApplied = report.phases?.harness_vision?.applied ?? [];
  const coverage = evaluateVisionCoverage({
    requiredIds,
    plannedById,
    results,
    previouslyApplied,
  });

  const accepted = [];
  const rejected = [...coverage.invalid];
  for (const answer of coverage.validNew) {
    if (previouslyApplied.includes(answer.id)) {
      rejected.push({ id: answer.id, reason: "already_applied" });
      continue;
    }
    for (const finding of answer.findings) {
      accepted.push(toVisionIssue(answer, finding, accepted.length));
    }
  }

  const appliedIds = new Set([
    ...previouslyApplied.map(String),
    ...coverage.validNew.map((a) => a.id),
  ]);

  // Drop gap finding only when coverage is fully complete.
  let priorIssues = report.issues || [];
  if (coverage.vision_complete) {
    priorIssues = priorIssues.filter(
      (issue) =>
        issue?.issue_id !== "vqa-vision-required-unavailable" &&
        issue?.issue_id !== "vqa-vision-review-incomplete",
    );
  } else {
    priorIssues = priorIssues.filter(
      (issue) => issue?.issue_id !== "vqa-vision-review-incomplete",
    );
    priorIssues.push({
      issue_id: "vqa-vision-review-incomplete",
      type: "vqa-vision",
      title: "Harness vision review incomplete",
      severity: "high",
      detail:
        "Not every planned vision request has a valid accepted answer; coverage stays incomplete.",
      evidence: redact({
        required: coverage.required,
        answered: coverage.answered,
        missing: coverage.missing,
        invalid: coverage.invalid,
      }),
    });
  }

  report.issues = dedupeIssues([...priorIssues, ...accepted]);

  const visionComplete = coverage.vision_complete;
  const limited = report.coverage?.limit_reason != null;
  const explorerComplete =
    !limited &&
    Number(report.coverage?.states || report.states?.length || 0) > 0;
  const complete = explorerComplete && visionComplete;

  report.coverage = {
    ...(report.coverage || {}),
    vision_required: true,
    vision_complete: visionComplete,
    vision_status: visionComplete
      ? "harness_applied"
      : "harness_incomplete",
    vision_requests: {
      required: coverage.required,
      answered: coverage.answered,
      missing: coverage.missing,
      invalid: coverage.invalid,
    },
  };
  report.complete = complete;
  // Incomplete vision is always COVERAGE_INCOMPLETE (fail-closed).
  report.verdict = visionComplete
    ? verdictFor({ issues: report.issues, complete })
    : "COVERAGE_INCOMPLETE";

  report.phases = report.phases || {};
  report.phases.harness_vision = {
    status: visionComplete ? "applied" : "incomplete",
    applied: [...appliedIds],
    accepted: accepted.length,
    rejected: rejected.length,
    vision_complete: visionComplete,
    required: coverage.required,
    answered: coverage.answered,
    missing: coverage.missing,
    invalid: coverage.invalid,
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
    ok: visionComplete && blocking.length === 0,
    required: coverage.required,
    answered: coverage.answered,
    missing: coverage.missing,
    invalid: coverage.invalid,
  };
}
