// Visual QA - application state identity.
//
// A state is not a page. Identity is derived from a bounded set of semantic
// signals so that volatile content (timestamps, ids, tokens) cannot fork the
// graph, while genuinely different UI (modal open, tab switched, empty vs.
// populated list) stays distinguishable.

import { createHash } from "node:crypto";

const VOLATILE = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?\b/g, "<ts>"],
  [/\b\d{2}[.:/]\d{2}[.:/]\d{2,4}\b/g, "<date>"],
  [/\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/gi, "<time>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b[0-9a-f]{16,}\b/gi, "<hex>"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>"],
  [/\b\d{6,}\b/g, "<num>"],
];

export function scrubVolatile(text = "") {
  let out = String(text);
  for (const [re, token] of VOLATILE) out = out.replace(re, token);
  return out.replace(/\s+/g, " ").trim();
}

/** Normalize a URL: drop origin noise, volatile query values, hash-only jumps. */
export function normalizeUrl(raw, baseUrl) {
  let u;
  try {
    u = new URL(raw, baseUrl);
  } catch {
    return String(raw);
  }
  const segments = u.pathname.split("/").map((seg) => {
    if (/^\d+$/.test(seg)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return ":uuid";
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ":hash";
    return seg;
  });
  const params = [...u.searchParams.keys()].sort();
  const query = params.length ? `?${params.join("&")}` : "";
  return `${segments.join("/") || "/"}${query}`;
}

/**
 * Fold a raw Playwright ARIA snapshot into a stable structural skeleton.
 * Keeps roles and (scrubbed) accessible names, drops depth beyond `maxDepth`
 * and caps sibling repetition so that a list of 500 cards and a list of 3 cards
 * of the same component do not produce different states.
 */
export function foldAria(snapshot, { maxDepth = 6, maxSiblings = 3 } = {}) {
  const lines = String(snapshot || "").split("\n");
  const kept = [];
  const runs = new Map();
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const depth = Math.floor(indent / 2);
    if (depth > maxDepth) continue;
    const body = scrubVolatile(line.trim().replace(/^-\s*/, ""));
    if (!body) continue;
    const role = body.split(/[\s"]/)[0];
    const key = `${depth}:${role}`;
    const n = (runs.get(key) || 0) + 1;
    runs.set(key, n);
    if (n > maxSiblings) {
      if (n === maxSiblings + 1) kept.push(`${" ".repeat(depth * 2)}${role} ...repeated`);
      continue;
    }
    kept.push(`${" ".repeat(depth * 2)}${body}`);
  }
  return kept.join("\n");
}

/**
 * Build the state fingerprint. Signals are deliberately explicit so a diff of
 * two state records tells you *why* they were considered different.
 */
export function buildState({ url, baseUrl, aria, headings, controls, dialogOpen, viewport }) {
  const signals = {
    route: normalizeUrl(url, baseUrl),
    dialog: dialogOpen ? "open" : "closed",
    viewport: viewport || "desktop",
    headings: (headings || []).slice(0, 8).map(scrubVolatile),
    controls: [...new Set((controls || []).map((c) => `${c.role}:${scrubVolatile(c.name)}`))]
      .sort()
      .slice(0, 40),
    structure: foldAria(aria),
  };
  const id = createHash("sha1")
    .update(JSON.stringify(signals))
    .digest("hex")
    .slice(0, 12);
  const label = `${signals.route}${dialogOpen ? "#dialog" : ""}:${signals.viewport}`;
  return { state_id: `${label}@${id}`, label, signals };
}
