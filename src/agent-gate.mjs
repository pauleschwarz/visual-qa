// Visual QA - autonomous agent evidence gate.
//
// This module never runs an agent, browser, or verifier. It only joins two
// independently-produced receipts and fails closed when either proof is absent,
// incomplete, stale, or non-passing.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  return value;
}

async function readJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error.message}`);
  }
  try {
    return object(JSON.parse(raw), label);
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${path}: ${error.message}`);
  }
}

function receiptEvidence(receipt, fields) {
  return Object.fromEntries(fields.map((field) => [field, receipt[field] ?? null]));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Agent-run evidence (when present) must carry non-empty Git state and
 * design-contract metadata. Direct non-agent runs omit agent_run and stay compatible.
 */
export function evaluateAgentRunBindings(visual) {
  const blockers = [];
  const agent = visual.agent_run;
  if (!agent || typeof agent !== "object") {
    return { required: false, blockers };
  }

  const git = agent.git;
  if (!git || typeof git !== "object") {
    blockers.push("visual_qa_agent_git_missing");
  } else {
    if (!nonEmptyString(git.head)) blockers.push("visual_qa_agent_git_head_missing");
    if (!nonEmptyString(git.ref) && !nonEmptyString(git.git_ref))
      blockers.push("visual_qa_agent_git_ref_missing");
    if (!nonEmptyString(git.diff_sha256) && !nonEmptyString(git.diff_sha))
      blockers.push("visual_qa_agent_git_diff_missing");
  }

  // Design binding only when agent-run (or report) actually recorded a contract.
  // Generic projects without DESIGN.md stay compatible (null is OK).
  const design = visual.design_contract ?? agent.design_contract ?? null;
  if (design != null) {
    if (typeof design !== "object" || Array.isArray(design)) {
      blockers.push("visual_qa_design_contract_invalid");
    } else {
      if (!nonEmptyString(design.sha256) && !nonEmptyString(design.sha))
        blockers.push("visual_qa_design_contract_sha_missing");
      if (!nonEmptyString(design.path))
        blockers.push("visual_qa_design_contract_path_missing");
    }
  }

  return { required: true, blockers };
}

/**
 * Combine independently-generated Visual QA and Pi Verity evidence. A PASS is
 * intentionally narrow: visual exploration must be complete and pass, Verity
 * must pass, and the Verity receipt cannot say it is stale. This is a gate, not
 * an orchestrator; it cannot mutate application or repository state.
 */
export function evaluateAgentGate({ visual, verity }) {
  object(visual, "Visual QA report");
  object(verity, "Verity receipt");
  const blockers = [];
  if (visual.verdict !== "PASS") blockers.push(`visual_qa_verdict_${visual.verdict ?? "missing"}`);
  if (
    Array.isArray(visual.issues) &&
    visual.issues.some((issue) => ["critical", "high"].includes(issue?.severity))
  )
    blockers.push("visual_qa_unresolved_issues");
  if (visual.complete !== true) blockers.push("visual_qa_incomplete");
  if (visual.coverage?.vision_complete !== true) blockers.push("visual_qa_vision_incomplete");

  // Stale / review-incomplete evidence cannot PASS.
  if (
    visual.coverage?.vision_status === "harness_incomplete" ||
    visual.phases?.harness_vision?.vision_complete === false
  ) {
    blockers.push("visual_qa_review_incomplete");
  }
  if (
    Array.isArray(visual.coverage?.vision_requests?.missing) &&
    visual.coverage.vision_requests.missing.length > 0
  ) {
    blockers.push("visual_qa_review_incomplete");
  }

  const agentBindings = evaluateAgentRunBindings(visual);
  blockers.push(...agentBindings.blockers);

  if (verity.verdict !== "PASS")
    blockers.push(`verity_verdict_${verity.verdict ?? "missing"}`);
  if (verity.repository_changed_since_baseline !== false)
    blockers.push("verity_receipt_stale");

  const durationMs = visual.duration_ms;
  if (!Number.isFinite(durationMs) || durationMs < 0)
    blockers.push("visual_qa_invalid_duration_ms");
  const visualFinishedAt = Date.parse(visual.started_at) + durationMs;
  const verityCreatedAt = Date.parse(verity.created_at);
  if (
    !Number.isFinite(visualFinishedAt) ||
    !Number.isFinite(verityCreatedAt) ||
    verityCreatedAt < visualFinishedAt
  )
    blockers.push("verity_predates_visual_qa");

  const uniqueBlockers = [...new Set(blockers)];
  return {
    schema_version: "vqa-agent-gate-0.1",
    product: "Visual QA agent gate",
    verdict: uniqueBlockers.length ? "UNPROVEN" : "PASS",
    ok: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    evidence: {
      visual_qa: {
        ...receiptEvidence(visual, [
          "schema_version",
          "run_id",
          "started_at",
          "duration_ms",
          "verdict",
          "complete",
        ]),
        vision_complete: visual.coverage?.vision_complete ?? null,
        design_contract: visual.design_contract ?? null,
        agent_git: visual.agent_run?.git
          ? {
              head: visual.agent_run.git.head ?? null,
              ref: visual.agent_run.git.ref ?? visual.agent_run.git.git_ref ?? null,
              diff_sha256: visual.agent_run.git.diff_sha256 ?? null,
            }
          : null,
      },
      verity: receiptEvidence(verity, [
        "schema_version",
        "verdict",
        "created_at",
        "final_diff_hash",
        "repository_changed_since_baseline",
      ]),
    },
  };
}

/** Write a portable gate receipt from receipts already produced by other tools. */
export async function writeAgentGate(
  outDir,
  { visual, verity, visualFile, verityFile } = {},
) {
  const resolvedVisual = visual ?? (await readJson(resolve(visualFile), "Visual QA report"));
  const resolvedVerity = verity ?? (await readJson(resolve(verityFile), "Verity receipt"));
  const result = evaluateAgentGate({ visual: resolvedVisual, verity: resolvedVerity });
  const path = join(resolve(outDir), "agent-gate.json");
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  return { ...result, path };
}
