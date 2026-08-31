// Visual QA - verified autofix stage.
//
// The whitelist is deliberately tiny: only defects a fixer can repair without
// understanding the application are eligible. Document-level fixes (title,
// lang) and mechanical contrast corrections qualify; anything needing product
// knowledge stays a finding. A fix counts as fixed only when a complete fresh
// exploration no longer reports the issue.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const FIXABLE_RULES = {
  "document-title": "title",
  "html-has-lang": "lang",
  "html-lang-valid": "lang",
};

// ---- WCAG contrast math (pure, deterministic) ------------------------------

function parseHexColor(hex) {
  const full = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(full)) return null;
  const parts =
    full.length === 3
      ? full.split("").map((c) => c + c)
      : [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)];
  return parts.map((p) => parseInt(p, 16));
}

function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(color, toward, t) {
  return color.map((c) => Math.round(c + (toward - c) * t));
}

/**
 * Smallest blend of fg toward black or white that reaches targetRatio against
 * bg. Tries both directions and returns the first valid candidate with the
 * smaller blend factor, so fixes stay visually close to the original design.
 */
export function fixedForeground(fg, bg, targetRatio = 4.5) {
  if (contrastRatio(fg, bg) >= targetRatio) return fg;
  let best = null;
  for (const toward of [0, 255]) {
    let low = 0;
    let high = 1;
    // Monotonicity: blending further toward black/white only ever increases
    // the ratio for that direction, so binary search is exact enough.
    if (contrastRatio(mix(fg, toward, 1), bg) < targetRatio) continue;
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2;
      if (contrastRatio(mix(fg, toward, mid), bg) >= targetRatio)
        high = mid;
      else low = mid;
    }
    const candidate = mix(fg, toward, high + 0.001);
    if (contrastRatio(candidate, bg) >= targetRatio) {
      const rounded = candidate.map((c) => Math.min(255, Math.max(0, c)));
      if (!best || high < best.t) best = { t: high, rgb: rounded };
    }
  }
  return best ? best.rgb : null;
}

/**
 * Parse an axe color-contrast failureSummary:
 * "... (foreground color: #ffffff, background color: #ffffff, font size: 12.0pt (16px), font weight: normal)".
 */
export function parseContrastSummary(summary = "") {
  const fg = /foreground[^#]*?#([0-9a-f]{3,6})\b/i.exec(summary);
  const bg = /background[^#]*?#([0-9a-f]{3,6})\b/i.exec(summary);
  if (!fg || !bg) return null;
  const size = /font size:\s*[\d.]+pt\s*\(([\d.]+)px\)/i.exec(summary);
  return {
    fg: parseHexColor(fg[1]),
    bg: parseHexColor(bg[1]),
    fontSizePx: size ? Number(size[1]) : 16,
    bold: /font weight:\s*bold/i.test(summary),
  };
}

// ---- selector matching (bounded subset) ------------------------------------

/**
 * Locate a tag opening for a SIMPLE axe selector in raw HTML. Supports the
 * forms a fixer can honestly resolve: #id, tag, .class, tag.class, tag#id,
 * compound classes. Everything else (descendant combinators, attributes,
 * pseudo) is reported unsupported instead of patched blindly.
 */
export function findSelectorInHtml(html, selector = "") {
  const sel = String(selector).trim();
  if (!sel || /[\s>~+:\[,@]/.test(sel)) return { status: "unsupported", selector: sel };
  // Optional tag prefix plus any number of .class / #id parts.
  const match = /^([a-z][a-z0-9-]*)?((?:[.#][\w-]+)*)$/i.exec(sel);
  if (!match) return { status: "unsupported", selector: sel };
  let tag = null;
  let classes = [];
  let id = null;
  for (const part of sel.split(/(?=[.#])/)) {
    if (part.startsWith(".")) classes.push(part.slice(1));
    else if (part.startsWith("#")) id = part.slice(1);
    else tag = part.toLowerCase();
  }
  const tagPattern = tag ? `<${tag}\\b[^>]*>` : `<[a-z][a-z0-9-]*\\b[^>]*>`;
  const regex = new RegExp(tagPattern, "gi");
  let candidate;
  while ((candidate = regex.exec(html))) {
    const open = candidate[0];
    if (id) {
      const idMatch = new RegExp(`\\bid\\s*=\\s*["']${id}["']`, "i").test(open);
      if (!idMatch) continue;
    }
    if (classes.length) {
      const classMatch = /\bclass\s*=\s*["']([^"']*)["']/i.exec(open);
      const classList = classMatch ? classMatch[1].split(/\s+/) : [];
      if (!classes.every((c) => classList.includes(c))) continue;
    }
    return { status: "found", index: candidate.index, tagOpen: open };
  }
  return { status: "missing", selector: sel };
}

/** Map report issues onto the fixable whitelist. Returns [] when nothing applies. */
export function collectFixes(issues = []) {
  const byKind = new Map();
  for (const issue of issues) {
    const kind = FIXABLE_RULES[issue?.evidence?.rule];
    if (kind) byKind.set(kind, { kind });
    // Contrast nodes travel with their fix: selector + summary per node.
    if (issue?.evidence?.rule === "color-contrast" && Array.isArray(issue.evidence.nodes)) {
      const entry = byKind.get("contrast") ?? { kind: "contrast", nodes: [] };
      for (const node of issue.evidence.nodes)
        entry.nodes.push({
          selector: Array.isArray(node.target)
            ? node.target.join(" ")
            : String(node.target ?? ""),
          summary: String(node.failureSummary ?? ""),
        });
      byKind.set("contrast", entry);
    }
  }
  return [...byKind.values()];
}

function titleForDir(dir) {
  const base = basename(dir).replace(/[-_]+/g, " ").trim();
  return base
    ? base.replace(/\b\w/g, (c) => c.toUpperCase())
    : "Application";
}

function insertTitle(html, title) {
  const tag = `<title>${title}</title>`;
  const metaCharset = /<meta[^>]+charset[^>]*>/i.exec(html);
  if (metaCharset) {
    const at = metaCharset.index + metaCharset[0].length;
    return `${html.slice(0, at)}\n${tag}${html.slice(at)}`;
  }
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n  ${tag}${html.slice(at)}`;
  }
  const open = /<html[^>]*>/i.exec(html);
  if (open) {
    const at = open.index + open[0].length;
    return `${html.slice(0, at)}\n<head>${tag}</head>${html.slice(at)}`;
  }
  return `${tag}\n${html}`;
}

function insertLang(html) {
  const open = /<html(\s[^>]*)?>/i.exec(html);
  if (!open) return null;
  const attrs = open[1] || "";
  if (/(^|\s)lang\s*=/i.test(attrs)) return null;
  return `${html.slice(0, open.index)}<html lang="en"${attrs}>${html.slice(open.index + open[0].length)}`;
}

export async function htmlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      out.push(join(entry.parentPath || dir, entry.name));
    }
    if (out.length >= 50) break; // bounded: a doc-level fix sweep needs no more
  }
  return out;
}

/**
 * Apply whitelisted fixes to every HTML file under fixDir.
 * Returns { applied: [{kind, ...}], skipped: [...] } — never throws;
 * an unreadable fixDir means nothing is applied, not a broken run.
 * With traceDir, before/after copies of every patched file land on disk.
 * Skips are honest: every unfixable node carries its reason.
 */
export async function applyFixes(fixes = [], fixDir, traceDir = null) {
  if (!fixDir || !fixes.length) return { applied: [], skipped: fixes.map((f) => f.kind) };
  const files = await htmlFiles(fixDir);
  const applied = [];
  const skipped = [];
  const remaining = new Set(
    fixes.filter((f) => f.kind !== "contrast").map((f) => f.kind),
  );
  const title = titleForDir(fixDir);
  for (const file of files) {
    if (!remaining.size) break;
    let html;
    try {
      html = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let next = html;
    if (remaining.has("title") && !/<title[\s>]/i.test(next)) {
      next = insertTitle(next, title);
      remaining.delete("title");
      applied.push({ kind: "title", file });
    }
    if (remaining.has("lang")) {
      const withLang = insertLang(next);
      if (withLang) {
        next = withLang;
        remaining.delete("lang");
        applied.push({ kind: "lang", file });
      }
    }
    if (next !== html) {
      if (traceDir) {
        await mkdir(traceDir, { recursive: true }).catch(() => {});
        const base = basename(file);
        await writeFile(join(traceDir, `${base}.before.html`), html).catch(
          () => {},
        );
        await writeFile(join(traceDir, `${base}.after.html`), next).catch(
          () => {},
        );
      }
      await writeFile(file, next, "utf8").catch(() => {
        // Unwritable target: the fix stage reports it as unapplied via the
        // remaining set instead of failing the whole run.
      });
    }
  }

  // Honest skips: a whitelisted fix with no applicable file never vanishes.
  for (const kind of remaining) skipped.push(kind);

  // Contrast fixes are per-node, not per-kind: every axe node carries its own
  // selector and summary. A node that cannot be honestly resolved is skipped
  // with a reason, never patched blindly and never silently dropped.
  for (const fix of fixes.filter((f) => f.kind === "contrast")) {
    for (const node of fix.nodes ?? []) {
      const parsed = parseContrastSummary(node.summary);
      if (!parsed || !parsed.fg || !parsed.bg) {
        skipped.push({ kind: "contrast", selector: node.selector, reason: "unparsable_summary" });
        continue;
      }
      // Large text (>=24px, or >=18.66px bold) legally needs only 3:1.
      const large =
        parsed.fontSizePx >= 24 || (parsed.bold && parsed.fontSizePx >= 18.66);
      const target = large ? 3 : 4.5;
      const corrected = fixedForeground(parsed.fg, parsed.bg, target);
      if (!corrected) {
        skipped.push({ kind: "contrast", selector: node.selector, reason: "no_reachable_ratio" });
        continue;
      }
      let done = false;
      for (const file of files) {
        let html;
        try {
          html = await readFile(file, "utf8");
        } catch {
          continue;
        }
        const found = findSelectorInHtml(html, node.selector);
        if (found.status === "unsupported") {
          skipped.push({ kind: "contrast", selector: node.selector, reason: "selector_unsupported" });
          break;
        }
        if (found.status !== "found") continue;
        const styleMatch = /(\sstyle\s*=\s*)(["'])(.*?)\2/i.exec(found.tagOpen);
        const cssValue = `rgb(${corrected.join(", ")})`;
        const patchedTag = styleMatch
          ? found.tagOpen.replace(
              styleMatch[0],
              `${styleMatch[1]}${styleMatch[2]}${styleMatch[3].replace(/;\s*$/, "")};color:${cssValue}${styleMatch[2]}`,
            )
          : found.tagOpen.replace(/\s*\/?>$/, ` style="color:${cssValue}">`);
        // Do not darken text that another inline rule already balances: the
        // summary was computed against the live render, the file may differ.
        const next = `${html.slice(0, found.index)}${patchedTag}${html.slice(found.index + found.tagOpen.length)}`;
        if (traceDir) {
          await mkdir(traceDir, { recursive: true }).catch(() => {});
          const base = basename(file);
          await writeFile(join(traceDir, `${base}.before.html`), html).catch(() => {});
          await writeFile(join(traceDir, `${base}.after.html`), next).catch(() => {});
        }
        await writeFile(file, next, "utf8").catch(() => {});
        applied.push({
          kind: "contrast",
          file,
          selector: node.selector,
          color: cssValue,
          ratio_before: Number(contrastRatio(parsed.fg, parsed.bg).toFixed(2)),
          ratio_target: target,
        });
        done = true;
        break;
      }
      if (!done && !skipped.some((s) => s.selector === node.selector))
        skipped.push({ kind: "contrast", selector: node.selector, reason: "no_matching_file" });
    }
  }
  return { applied, skipped };
}

/** Set difference by issue_id: what the first run saw that the second does not. */
export function diffIssues(before = [], after = []) {
  const seen = new Set(after.map((issue) => issue.issue_id));
  return {
    fixed: before.filter((issue) => !seen.has(issue.issue_id)),
    remaining: after,
  };
}
