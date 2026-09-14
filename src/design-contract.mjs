// DESIGN.md contract: optional project design authority for vision review.
// Explicit --design-contract must exist; bare DESIGN.md is auto-discovered when present.

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const DESIGN_NAME = "DESIGN.md";

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Resolve design contract path + content.
 * - explicitPath set: must be readable or throw (fail early).
 * - else: look for DESIGN.md under projectRoot (cwd / invoking project); missing is OK.
 */
export async function resolveDesignContract({
  explicitPath = null,
  projectRoot = process.cwd(),
} = {}) {
  if (explicitPath != null && String(explicitPath).trim() !== "") {
    const path = resolve(String(explicitPath).trim());
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(
        `design-contract unreadable at ${path}: ${error.message}`,
      );
    }
    return {
      path,
      content,
      sha256: sha256Hex(content),
      source: "explicit",
    };
  }

  const candidate = isAbsolute(DESIGN_NAME)
    ? DESIGN_NAME
    : join(resolve(projectRoot), DESIGN_NAME);
  if (!(await fileExists(candidate))) {
    return null;
  }
  const content = await readFile(candidate, "utf8");
  return {
    path: candidate,
    content,
    sha256: sha256Hex(content),
    source: "discovered",
  };
}

/** Metadata block stored on report.json when a contract is in force. */
export function designContractMeta(contract) {
  if (!contract) return null;
  return {
    path: contract.path,
    sha256: contract.sha256,
    source: contract.source,
    bytes: Buffer.byteLength(contract.content, "utf8"),
  };
}

/**
 * Append authoritative DESIGN.md text + preservation rules to a vision system prompt.
 */
export function appendDesignContractToPrompt(systemPrompt, contract) {
  if (!contract?.content) return systemPrompt;
  return (
    `${systemPrompt}\n\n` +
    `## Authoritative DESIGN.md contract (path=${contract.path}, sha256=${contract.sha256})\n` +
    `Treat the following as the product design authority for this review. ` +
    `Preserve intentional design: only flag a difference as a defect when it violates this contract, ` +
    `visibly regresses a baseline, creates a usability/accessibility defect, or clearly violates stated intent. ` +
    `Uncertainty preserves the existing UI — do not invent style preferences beyond this contract.\n\n` +
    `--- DESIGN.md BEGIN ---\n${contract.content}\n--- DESIGN.md END ---`
  );
}
