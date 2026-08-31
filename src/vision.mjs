import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "./config.mjs";

/**
 * Review skills are prompt packs, not models. The orchestrator stays
 * deterministic and merely dispatches the same screenshot pairs to each
 * skill; any OpenAI-compatible multimodal endpoint can serve them. The
 * same packs are exported for harness-driven review: the calling agent's
 * own vision model can answer them (see review.mjs).
 */
export const SKILLS = {
  layout: {
    focus:
      "Broken layout: overlapping, clipped or off-screen elements, collapsed containers, misaligned grids, horizontal overflow.",
  },
  readability: {
    focus:
      "Readability: text too small or low contrast, unreadable text over images, cramped spacing, truncated labels, missing focus states.",
  },
  slop: {
    focus:
      "AI slop: placeholder copy, lorem ipsum, scaffold defaults, emoji soup, generic marketing filler, inconsistent tone.",
  },
  consistency: {
    focus:
      "Consistency: mixed fonts or button styles, inconsistent spacing, conflicting colors, mismatched icon sets, dead or duplicated controls.",
  },
};

const SHARED_CONTRACT =
  'You are a visual QA reviewer. You see two screenshots of one user action (before, after). Report ONLY visible UI defects in your focus area. Ignore animations/carets. Reply with JSON ONLY: {"findings":[{"title":string,"severity":"high"|"medium"|"low","detail":string}]}. Empty findings array if the action looks fine.';

export function skillPrompt(skill) {
  if (!SKILLS[skill]) throw new Error(`Unknown vision skill "${skill}"`);
  return `${SHARED_CONTRACT} Focus: ${SKILLS[skill].focus}`;
}

const SKILL_KEYS = Object.keys(SKILLS);

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

function parseFindings(content) {
  if (typeof content !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && Array.isArray(parsed.findings)
    ? parsed.findings
    : null;
}

export async function runVisionReview({
  report,
  config,
  fetchImpl = globalThis.fetch,
  readFileImpl,
} = {}) {
  let attempted = 0;
  let completed = 0;
  const issues = [];

  try {
    const calls = Math.min(12, config?.bounds?.max_agent_calls || 0);
    if (calls < 1)
      return { status: "skipped_no_calls", issues: [], attempted, completed };

    const key = process.env.VQA_VISION_API_KEY;
    if (!key)
      return {
        status: "skipped_no_endpoint",
        issues: [],
        attempted,
        completed,
      };

    const endpoint =
      process.env.VQA_VISION_ENDPOINT || "https://api.openai.com/v1";
    const model = process.env.VQA_VISION_MODEL || "gpt-4o-mini";
    const readFile =
      readFileImpl ?? (await import("node:fs/promises")).readFile;
    const traceDir = config?.outDir
      ? join(config.outDir, "vision")
      : null;
    if (traceDir) await mkdir(traceDir, { recursive: true }).catch(() => {});
    const runId = randomUUID().slice(0, 8);
    const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
    const pairs = evidence
      .map(screenshotPair)
      .filter(Boolean)
      .sort((left, right) => priority(left.entry) - priority(right.entry));
    // Distinct from skipped_no_calls: the review was armed but the
    // exploration produced no screenshot pairs to review (e.g. every action
    // was skipped). Reporting "error" here would blame the endpoint.
    if (pairs.length === 0)
      return {
        status: "skipped_no_pairs",
        issues: [],
        attempted,
        completed,
      };
    // The call budget is global across skills: each pair x skill is one call,
    // and the walk stops the moment the budget is spent, keeping later (more
    // critical) pairs available for earlier skills rather than starving them.
    let spent = 0;

    for (const skill of SKILL_KEYS) {
      if (spent >= calls) break;
      for (const { entry, beforePath, afterPath } of pairs) {
        if (spent >= calls) break;
        let beforeDataUrl;
        let afterDataUrl;
        try {
          beforeDataUrl = `data:image/png;base64,${Buffer.from(
            await readFile(beforePath),
          ).toString("base64")}`;
          afterDataUrl = `data:image/png;base64,${Buffer.from(
            await readFile(afterPath),
          ).toString("base64")}`;
        } catch {
          continue;
        }

        attempted += 1;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        let raw = null;
        try {
          const response = await fetchImpl(`${endpoint}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              max_tokens: 700,
              messages: [
                { role: "system", content: skillPrompt(skill) },
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Review the before and after screenshots for action ${String(entry.action_id || "unknown")}.`,
                    },
                    {
                      type: "image_url",
                      image_url: { url: beforeDataUrl },
                    },
                    {
                      type: "image_url",
                      image_url: { url: afterDataUrl },
                    },
                  ],
                },
              ],
            }),
            signal: controller.signal,
          });

          const status = response?.status;
          const successful =
            response?.ok === true ||
            (Number.isFinite(status) && status >= 200 && status < 300);
          if (!successful) continue;

          const payload = await response.json();
          raw = payload;
          const content = payload?.choices?.[0]?.message?.content;
          const findings = parseFindings(content);
          if (!findings) continue;

          completed += 1;
          const accepted = [];
          for (const finding of findings) {
            if (
              !finding ||
              typeof finding !== "object" ||
              typeof finding.title !== "string" ||
              typeof finding.detail !== "string" ||
              !["high", "medium", "low"].includes(finding.severity)
            )
              continue;

            // Severity cap keeps vision additive; it cannot flip the deterministic verdict to FAIL.
            const severity = finding.severity === "high" ? "medium" : finding.severity;
            const visionIssue = {
              issue_id: `vqa-vision-${issues.length}-${slug(finding.title)}`,
              type: "vqa-vision",
              title: finding.title,
              severity,
              detail: finding.detail,
              evidence: redact({
                source: "vision",
                skill,
                model,
                action_id: entry.action_id,
                screenshot_pair: [beforePath, afterPath],
              }),
            };
            issues.push(visionIssue);
            accepted.push(visionIssue);
          }
          // Traceability: every completed call leaves its raw response and the
          // accepted findings on disk, keyed by run, skill, and action.
          if (traceDir) {
            const base = `${runId}-${skill}-${slug(String(entry.action_id || "unknown")).slice(0, 40)}`;
            await writeFile(
              join(traceDir, `${base}.response.json`),
              `${JSON.stringify(raw, null, 2)}\n`,
            ).catch(() => {});
            await writeFile(
              join(traceDir, `${base}.findings.json`),
              `${JSON.stringify({ skill, model, action_id: entry.action_id, findings: accepted }, null, 2)}\n`,
            ).catch(() => {});
          }
        } catch {
          continue;
        } finally {
          clearTimeout(timeout);
        }
        spent += 1;
      }
    }

    return {
      status: completed >= 1 ? "ok" : "error",
      issues,
      attempted,
      completed,
    };
  } catch {
    return {
      status: completed >= 1 ? "ok" : "error",
      issues,
      attempted,
      completed,
    };
  }
}
