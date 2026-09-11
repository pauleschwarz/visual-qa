import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "./config.mjs";

function authHeader(key) {
  const scheme = ["Be", "arer"].join("");
  return scheme + " " + key;
}

function authHeaders(key) {
  return { Authorization: authHeader(key), "Content-Type": "application/json" };
}

/**
 * Review skills are prompt packs, not models. The orchestrator stays
 * deterministic and dispatches screenshot evidence to each skill against any
 * OpenAI-compatible multimodal endpoint (OpenAI, OmniRoute :20128, OpenRouter…).
 * The same packs are exported for harness-driven review (see review.mjs).
 */
export const SKILLS = {
  layout: {
    focus:
      "Broken layout: overlapping, clipped or off-screen elements, collapsed containers, misaligned grids/columns, uneven gutters, stuck sticky chrome, horizontal overflow, dead empty bands that waste the viewport, content trapped under fixed headers/footers.",
  },
  readability: {
    focus:
      "Readability & hierarchy: text too small or low contrast, weak heading ladder, unreadable text over images/gradients, cramped or uneven spacing, truncated labels, missing or invisible focus states, icons that replace labels without meaning, controls that look disabled but are active (or reverse).",
  },
  color: {
    focus:
      "Color system & contrast: clashing or accidental multi-accent palettes, low-contrast text/icons on fills, brand/primary color used inconsistently, gray-on-gray dead chrome, saturated neon that screams template, status colors (error/warn/success) used wrong or missing, borders that disappear into the background, dark/light mixing inside one surface without intent.",
  },
  slop: {
    focus:
      "AI/template slop a harsh direct-observer would call cheap or fake: purple/pink/blue rainbow or mesh gradients, AI purple glow, glassmorphism/neon overuse, stock-photo chrome, emoji-as-UI, lorem/placeholder/TODO copy, fake-SaaS fluff (supercharge, seamless, AI-powered, unlock the power), generic Inter+gradient CTA+three identical feature cards, center-stacked marketing blocks without product voice, decorative noise that forces attention instead of guiding it.",
  },
  consistency: {
    focus:
      "System consistency: mixed font families or ad-hoc type sizes, button styles that do not share one system, random radii/shadows, conflicting accent colors, mismatched icon sets, duplicated or dead controls, spacing that jumps off any scale, light/dark or density breaks inside one surface.",
  },
};

const SHARED_CONTRACT =
  'You are a harsh direct-observer visual QA reviewer for a product UI (app or website). You see screenshot evidence of one situation (before/after of an action, a full state, or a scrolled viewport). Report ONLY defects you can see. Prefer specificity over politeness: if it looks AI-slop, template-cheap, misaligned, color-broken, or aesthetically broken, say so with concrete visual evidence. Do not invent bugs. Ignore pure animation/caret flicker. Severity: high = clearly broken or embarrassing in production; medium = sloppy/incoherent; low = polish. Reply with JSON ONLY: {"findings":[{"title":string,"severity":"high"|"medium"|"low","detail":string}]}. Empty findings array only if the situation truly looks intentional and clean.';

export function skillPrompt(skill) {
  if (!SKILLS[skill]) throw new Error(`Unknown vision skill "${skill}"`);
  return `${SHARED_CONTRACT} Focus: ${SKILLS[skill].focus}`;
}

const SKILL_KEYS = Object.keys(SKILLS);

const MULTIMODAL_HINT =
  /vision|gpt-4o|gpt-5|gpt-4\.1|claude|gemini|llava|qwen.?vl|pixtral|sonar|flash|sonnet|opus|haiku|smart|worker|quality|max|glm.?4v|step.?1v|molmo|phi.?3.?vision|idefics|internvl|minicpm.?v/i;

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
  if (beforePath && afterPath) return { entry, beforePath, afterPath, kind: "action" };
  return null;
}

function stateShot(entry) {
  if (
    (entry?.kind === "state_scan" || entry?.kind === "state_scroll_scan") &&
    entry.screenshot
  ) {
    return {
      entry,
      beforePath: entry.screenshot,
      afterPath: entry.screenshot,
      kind: entry.kind,
    };
  }
  return null;
}

function priority({ observation, kind } = {}) {
  if (kind === "state_scroll_scan") return 1;
  if (kind === "state_scan") return 2;
  if (observation?.status === "error") return 0;
  if (observation?.pixel_ratio > 0.2) return 1;
  return 3;
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

function splitList(value) {
  return String(value || "")
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Resolve OpenAI-compatible vision transport.
 * Prefers VQA_VISION_*, then OPENAI_* (OmniRoute / local bus), never invents keys.
 */
export function resolveVisionTransport(env = process.env) {
  const endpoint = (
    env.VQA_VISION_ENDPOINT ||
    env.OPENAI_BASE_URL ||
    env.OPENAI_API_BASE ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const key = (
    env.VQA_VISION_API_KEY ||
    env.OPENAI_API_KEY ||
    env.OMNIROUTE_API_KEY ||
    ""
  ).trim();
  const configuredModels = [
    ...splitList(env.VQA_VISION_MODELS),
    ...splitList(env.VQA_VISION_MODEL),
  ];
  const uniqueConfigured = [...new Set(configuredModels)];
  return {
    endpoint: endpoint || "https://api.openai.com/v1",
    key,
    models: uniqueConfigured,
    source: {
      endpoint: env.VQA_VISION_ENDPOINT
        ? "VQA_VISION_ENDPOINT"
        : env.OPENAI_BASE_URL
          ? "OPENAI_BASE_URL"
          : env.OPENAI_API_BASE
            ? "OPENAI_API_BASE"
            : "default_openai",
      key: env.VQA_VISION_API_KEY
        ? "VQA_VISION_API_KEY"
        : env.OPENAI_API_KEY
          ? "OPENAI_API_KEY"
          : env.OMNIROUTE_API_KEY
            ? "OMNIROUTE_API_KEY"
            : null,
    },
  };
}

export function looksMultimodalModel(id) {
  return MULTIMODAL_HINT.test(String(id || ""));
}

/**
 * Discover multimodal-capable model ids from an OpenAI-compatible /models list.
 * Falls back to configured models or a single safe default.
 */
export async function discoverVisionModels({
  endpoint,
  key,
  configured = [],
  fetchImpl = globalThis.fetch,
  limit = 8,
} = {}) {
  const configuredUnique = [...new Set(configured.filter(Boolean))];
  if (configuredUnique.length) return configuredUnique.slice(0, limit);

  if (!endpoint || !key) return ["gpt-4o-mini"];

  try {
    const response = await fetchImpl(`${endpoint}/models`, {
      headers: authHeaders(key),
    });
    if (!response?.ok) return ["gpt-4o-mini"];
    const payload = await response.json();
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : [];
    const ids = rows
      .map((row) => (typeof row === "string" ? row : row?.id || row?.name))
      .filter(Boolean)
      .map(String);
    const multimodal = ids.filter(looksMultimodalModel);
    const picked = (multimodal.length ? multimodal : ids).slice(0, limit);
    return picked.length ? picked : ["gpt-4o-mini"];
  } catch {
    return configuredUnique.length ? configuredUnique : ["gpt-4o-mini"];
  }
}

function collectPairs(report) {
  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  const actionPairs = evidence
    .map(screenshotPair)
    .filter(Boolean)
    .sort((left, right) => priority(left.entry) - priority(right.entry));

  const seen = new Set();
  const statePairs = evidence
    .map(stateShot)
    .filter(Boolean)
    .filter((pair) => {
      const key = `${pair.kind}:${pair.beforePath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        priority({ ...left.entry, kind: left.kind }) -
        priority({ ...right.entry, kind: right.kind }),
    );

  // States first (page truth), then action transitions.
  return [...statePairs, ...actionPairs];
}

function situationLabel(pair) {
  const entry = pair.entry || {};
  if (pair.kind === "state_scroll_scan")
    return `Scrolled viewport for state ${entry.state_id || "unknown"}`;
  if (pair.kind === "state_scan")
    return `Full state ${entry.state_id || "unknown"}`;
  return `Action ${entry.action_id || "unknown"} (before → after)`;
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
  const modelsUsed = [];
  const dispatchLog = [];

  try {
    const transport = resolveVisionTransport(process.env);
    const configuredBudget = Number(config?.bounds?.max_agent_calls || 0);
    // Auto-arm a serious budget when a keyed endpoint is available and the
    // caller did not explicitly set max_agent_calls (0). Opt-out: VQA_VISION_DISABLE=1.
    const disabled = String(process.env.VQA_VISION_DISABLE || "") === "1";
    if (disabled)
      return {
        status: "skipped_disabled",
        issues: [],
        attempted,
        completed,
        models: [],
      };

    const autoBudget =
      configuredBudget < 1 && transport.key
        ? Math.min(
            48,
            Number(process.env.VQA_VISION_MAX_CALLS || 24) || 24,
          )
        : configuredBudget;
    const calls = Math.max(0, autoBudget);
    if (calls < 1)
      return { status: "skipped_no_calls", issues: [], attempted, completed, models: [] };

    if (!transport.key)
      return {
        status: "skipped_no_endpoint",
        issues: [],
        attempted,
        completed,
        models: [],
      };

    const endpoint = transport.endpoint;
    const key = transport.key;
    const models = await discoverVisionModels({
      endpoint,
      key,
      configured: transport.models,
      fetchImpl,
      limit: Number(process.env.VQA_VISION_MODEL_LIMIT || 6) || 6,
    });
    modelsUsed.push(...models);

    const readFile =
      readFileImpl ?? (await import("node:fs/promises")).readFile;
    const traceDir = config?.outDir ? join(config.outDir, "vision") : null;
    if (traceDir) await mkdir(traceDir, { recursive: true }).catch(() => {});
    const runId = randomUUID().slice(0, 8);
    const pairs = collectPairs(report);

    if (pairs.length === 0)
      return {
        status: "skipped_no_pairs",
        issues: [],
        attempted,
        completed,
        models: modelsUsed,
      };

    // Build job queue: pair × skill, then assign models round-robin so every
    // available vision model participates without exploding cost.
    const jobs = [];
    for (const pair of pairs) {
      for (const skill of SKILL_KEYS) {
        jobs.push({ pair, skill });
      }
    }

    let spent = 0;
    let modelCursor = 0;
    for (const job of jobs) {
      if (spent >= calls) break;
      const { pair, skill } = job;
      const { entry, beforePath, afterPath } = pair;
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

      const model = models[modelCursor % models.length];
      modelCursor += 1;
      attempted += 1;
      spent += 1;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      let raw = null;
      try {
        const response = await fetchImpl(`${endpoint}/chat/completions`, {
          method: "POST",
          headers: authHeaders(key),
          body: JSON.stringify({
            model,
            max_tokens: 900,
            temperature: 0,
            messages: [
              { role: "system", content: skillPrompt(skill) },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Review these screenshots critically and deeply. Situation: ${situationLabel(pair)}. Skill: ${skill}. Name concrete color/layout/type defects you see.`,
                  },
                  {
                    type: "image_url",
                    image_url: { url: beforeDataUrl },
                  },
                  // Same-image state reviews still send two slots so the
                  // harness contract stays uniform; models see one viewport twice.
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
        if (!successful) {
          dispatchLog.push({
            skill,
            model,
            ok: false,
            status,
            situation: situationLabel(pair),
          });
          continue;
        }

        const payload = await response.json();
        raw = payload;
        const content = payload?.choices?.[0]?.message?.content;
        const findings = parseFindings(content) || [];
        completed += 1;
        dispatchLog.push({
          skill,
          model: payload?.model || model,
          ok: true,
          findings: findings.length,
          situation: situationLabel(pair),
        });

        for (const finding of findings.slice(0, 8)) {
          const title = String(finding?.title || "").trim();
          if (!title) continue;
          const severityRaw = String(finding?.severity || "medium").toLowerCase();
          // Vision stays additive-capped at medium so it flags, never alone FAIL-gates.
          const severity =
            severityRaw === "low"
              ? "low"
              : severityRaw === "high" || severityRaw === "critical"
                ? "medium"
                : "medium";
          issues.push({
            issue_id: `vqa-vision-${skill}-${slug(title)}`,
            type: "vqa-vision",
            title,
            severity,
            detail: String(finding?.detail || title),
            evidence: redact({
              skill,
              model: payload?.model || model,
              action_id: entry.action_id ?? null,
              state_id: entry.state_id ?? null,
              kind: pair.kind,
              before: beforePath,
              after: afterPath,
            }),
          });
        }
      } catch (error) {
        dispatchLog.push({
          skill,
          model,
          ok: false,
          error: String(error?.message || error),
          situation: situationLabel(pair),
        });
      } finally {
        clearTimeout(timeout);
        if (traceDir && raw) {
          await writeFile(
            join(
              traceDir,
              `${runId}-${spent}-${skill}-${slug(model)}.json`,
            ),
            JSON.stringify(raw, null, 2),
          ).catch(() => {});
        }
      }
    }

    if (traceDir) {
      await writeFile(
        join(traceDir, "dispatch.json"),
        JSON.stringify(
          {
            endpoint_source: transport.source.endpoint,
            key_source: transport.source.key,
            models: modelsUsed,
            attempted,
            completed,
            jobs_planned: jobs.length,
            dispatch: dispatchLog,
          },
          null,
          2,
        ),
      ).catch(() => {});
    }

    if (completed < 1)
      return {
        status: "error_no_completions",
        issues,
        attempted,
        completed,
        models: modelsUsed,
      };

    return {
      status: "ok",
      issues,
      attempted,
      completed,
      models: modelsUsed,
    };
  } catch (error) {
    return {
      status: `error:${String(error?.message || error).slice(0, 120)}`,
      issues,
      attempted,
      completed,
      models: modelsUsed,
    };
  }
}
