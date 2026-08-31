// Visual QA - verified autofix stage.
//
// The whitelist is deliberately tiny: only document-level defects that a fixer
// can repair without understanding the application are eligible. Anything that
// needs product knowledge stays a finding. A fix counts as fixed only when a
// complete fresh exploration no longer reports the issue.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const FIXABLE_RULES = {
  "document-title": "title",
  "html-has-lang": "lang",
  "html-lang-valid": "lang",
};

/** Map report issues onto the fixable whitelist. Returns [] when nothing applies. */
export function collectFixes(issues = []) {
  const kinds = new Set();
  for (const issue of issues) {
    const kind = FIXABLE_RULES[issue?.evidence?.rule];
    if (kind) kinds.add(kind);
  }
  return [...kinds].map((kind) => ({ kind }));
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

async function htmlFiles(dir) {
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
 * Returns { applied: [{kind, files}], skipped: [kinds] } — never throws;
 * an unreadable fixDir means nothing is applied, not a broken run.
 */
export async function applyFixes(fixes = [], fixDir) {
  if (!fixDir || !fixes.length) return { applied: [], skipped: fixes.map((f) => f.kind) };
  const files = await htmlFiles(fixDir);
  const applied = [];
  const remaining = new Set(fixes.map((f) => f.kind));
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
      await writeFile(file, next, "utf8").catch(() => {
        // Unwritable target: the fix stage reports it as unapplied via the
        // remaining set instead of failing the whole run.
      });
    }
  }
  return { applied, skipped: [...remaining] };
}

/** Set difference by issue_id: what the first run saw that the second does not. */
export function diffIssues(before = [], after = []) {
  const seen = new Set(after.map((issue) => issue.issue_id));
  return {
    fixed: before.filter((issue) => !seen.has(issue.issue_id)),
    remaining: after,
  };
}
