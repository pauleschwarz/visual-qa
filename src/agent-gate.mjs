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

  return {
    schema_version: "vqa-agent-gate-0.1",
    product: "Visual QA agent gate",
    verdict: blockers.length ? "UNPROVEN" : "PASS",
    ok: blockers.length === 0,
    blockers,
    evidence: {
      visual_qa: receiptEvidence(visual, [
        "schema_version",
        "run_id",
        "started_at",
        "duration_ms",
        "verdict",
        "complete",
      ]),
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
