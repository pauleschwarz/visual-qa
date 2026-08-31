import { redact } from "./config.mjs";

const SYSTEM_CONTRACT =
  'You are a visual QA reviewer. You see two screenshots of one user action (before, after). Report ONLY visible UI defects: broken layout, overlapping/clipped elements, unreadable text, empty sections, AI-slop patterns (placeholder copy, scaffold defaults), broken images, dead interactive elements. Ignore animations/carets. Reply with JSON ONLY: {"findings":[{"title":string,"severity":"high"|"medium"|"low","detail":string}]}. Empty findings array if the action looks fine.';

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
    const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
    const pairs = evidence
      .map(screenshotPair)
      .filter(Boolean)
      .sort((left, right) => priority(left.entry) - priority(right.entry))
      .slice(0, calls);

    for (const { entry, beforePath, afterPath } of pairs) {
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
              { role: "system", content: SYSTEM_CONTRACT },
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
        const content = payload?.choices?.[0]?.message?.content;
        const findings = parseFindings(content);
        if (!findings) continue;

        completed += 1;
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
          issues.push({
            issue_id: `vqa-vision-${issues.length}-${slug(finding.title)}`,
            type: "vqa-vision",
            title: finding.title,
            severity,
            detail: finding.detail,
            evidence: redact({
              source: "vision",
              model,
              action_id: entry.action_id,
              screenshot_pair: [beforePath, afterPath],
            }),
          });
        }
      } catch {
        continue;
      } finally {
        clearTimeout(timeout);
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
