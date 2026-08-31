// Visual QA - intent-driven style changes with verified application.
//
// An instruction like: change the color of "Add item" to green - is parsed,
// patched into the static sources under fixDir, and then VERIFIED against the
// live computed style in a fresh exploration. An intent that cannot be applied
// or does not survive verification is a finding, never a silent no-op.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { redact } from "./config.mjs";
import { htmlFiles } from "./fix.mjs";

// Small closed color table: a parser that half-knows CSS color syntax would
// silently accept values the verifier then cannot reproduce.
const NAMED_COLORS = {
  rot: [220, 38, 38],
  red: [220, 38, 38],
  grün: [22, 163, 74],
  gruen: [22, 163, 74],
  green: [22, 163, 74],
  blau: [37, 99, 235],
  blue: [37, 99, 235],
  gelb: [234, 179, 8],
  yellow: [234, 179, 8],
  orange: [234, 88, 12],
  lila: [147, 51, 234],
  purple: [147, 51, 234],
  pink: [236, 72, 153],
  rosa: [236, 72, 153],
  schwarz: [17, 17, 17],
  black: [17, 17, 17],
  weiß: [245, 245, 245],
  weiss: [245, 245, 245],
  white: [245, 245, 245],
  grau: [115, 115, 115],
  gray: [115, 115, 115],
  grey: [115, 115, 115],
  cyan: [8, 145, 178],
  magenta: [192, 38, 211],
  braun: [120, 72, 40],
  brown: [120, 72, 40],
};

const TAG_ALIASES = {
  button: "button",
  buttons: "button",
  knopf: "button",
  schaltfläche: "button",
  überschrift: "h1,h2,h3",
  ueberschrift: "h1,h2,h3",
  heading: "h1,h2,h3",
  header: "header",
  kopfzeile: "header",
  text: "p",
  absatz: "p",
  paragraph: "p",
  link: "a",
  liste: "ul,ol",
  list: "ul,ol",
};

function hexToRgb(hex) {
  const full = hex.replace(/^#/, "");
  const short = full.length === 3;
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(full)) return null;
  const parts = short
    ? full.split("").map((c) => c + c)
    : [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)];
  return parts.map((p) => parseInt(p, 16));
}

function rgbFromValue(value) {
  const named = NAMED_COLORS[value.toLowerCase()];
  if (named) return named;
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) return hexToRgb(value);
  const fn = /^rgba?\((\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

/**
 * Parse one color-change instruction. Returns null for anything it does not
 * fully understand - an unparsed intent must fail loudly downstream, not
 * patch a guessed target.
 */
export function parseIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // Property: background/hintergrund wins over foreground when both appear.
  const property = /(background|hintergrund)/.test(lower)
    ? "background-color"
    : "color";

  // Value: quoted string, hex, rgb(), or a trailing named color.
  let value = null;
  const quotedValue = /(?:auf|to)\s+["']([^"']+)["']/i.exec(raw);
  const hexValue = /(#[0-9a-f]{3}|#[0-9a-f]{6})\b/i.exec(raw);
  const fnValue = /rgba?\([^)]*\)/i.exec(raw);
  const namedValue = /\b(?:auf|to)\s+([a-zäöüß]+)\s*$/i.exec(raw);
  if (quotedValue && rgbFromValue(quotedValue[1]))
    value = quotedValue[1];
  else if (hexValue) value = hexValue[1];
  else if (fnValue) value = fnValue[0].replace(/\s+/g, "");
  else if (namedValue && NAMED_COLORS[namedValue[1].toLowerCase()])
    value = namedValue[1];
  if (!value) return null;
  const valueRgb = rgbFromValue(value);
  if (!valueRgb) return null;

  // Target: quoted text beats a tag alias after von/des/der/dem/of/the.
  const quotedTarget = /(?:von|of|in)\s+["']([^"']+)["']/i.exec(raw);
  if (quotedTarget)
    return {
      kind: "color",
      property,
      value,
      valueRgb,
      target: { text: quotedTarget[1] },
      raw,
    };
  const tagTarget = /(?:von|of|des|der|dem|the)\s+(?:den\s+|die\s+|das\s+|dem\s+)?([a-zäöüß]+)\b/i.exec(
    raw,
  );
  if (tagTarget) {
    const tag = TAG_ALIASES[tagTarget[1].toLowerCase()];
    if (tag)
      return {
        kind: "color",
        property,
        value,
        valueRgb,
        target: { tag },
        raw,
      };
  }
  return null;
}

function stylePatch(tagOpen, property, value) {
  const styleMatch = /(\sstyle\s*=\s*)(["'])(.*?)\2/i.exec(tagOpen);
  if (styleMatch) {
    const merged = `${styleMatch[1]}${styleMatch[2]}${styleMatch[3].replace(/;\s*$/, "")};${property}:${value}${styleMatch[2]}`;
    return tagOpen.replace(styleMatch[0], merged);
  }
  return tagOpen.replace(/\s*\/?>$/, ` style="${property}:${value}">`);
}

/**
 * Patch the first matching element in every HTML file under fixDir.
 * Text targets pick the tag that immediately wraps the first occurrence of
 * the text; tag targets pick the first matching tag in document order.
 */
export async function applyIntent(intent, fixDir, traceDir = null) {
  if (!intent || !fixDir) return { applied: false, reason: "missing_input" };
  const files = await htmlFiles(fixDir);
  for (const file of files) {
    let html;
    try {
      html = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let index = -1;
    let tagOpen = null;
    if (intent.target.text) {
      index = html.indexOf(intent.target.text);
      if (index < 0) continue;
      // Walk back to the nearest tag opening before the text occurrence.
      const open = html.lastIndexOf("<", index);
      const close = html.lastIndexOf(">", index);
      // close < open means the text sits inside an attribute value of a tag
      // that has not closed yet - never patch that.
      if (open < 0 || close < open) continue;
      const end = html.indexOf(">", open);
      if (end < 0) continue;
      tagOpen = html.slice(open, end + 1);
      index = open;
    } else if (intent.target.tag) {
      // Aliases may list alternatives (h1,h2,h3): patch the first tag that
      // actually occurs, in document priority order.
      for (const tag of intent.target.tag.split(",")) {
        const match = new RegExp(`<(${tag})\\b[^>]*>`, "i").exec(html);
        if (!match) continue;
        tagOpen = match[0];
        index = match.index;
        break;
      }
      if (!tagOpen) continue;
    }
    if (!tagOpen) return { applied: false, reason: "no_match" };
    // CSS understands neither "grün" nor "rot": patch the resolved rgb value,
    // while the human word stays in the intent record for reporting.
    const cssValue =
      /^(#|rgb)/i.test(intent.value)
        ? intent.value
        : `rgb(${intent.valueRgb.join(", ")})`;
    const patched = stylePatch(tagOpen, intent.property, cssValue);
    if (patched === tagOpen)
      return { applied: false, reason: "patch_failed" };
    const next = `${html.slice(0, index)}${patched}${html.slice(index + tagOpen.length)}`;
    if (traceDir) {
      await mkdir(traceDir, { recursive: true }).catch(() => {});
      const base = basename(file);
      await writeFile(
        join(traceDir, `${base}.before.html`),
        html,
      ).catch(() => {});
      await writeFile(
        join(traceDir, `${base}.after.html`),
        next,
      ).catch(() => {});
    }
    await writeFile(file, next, "utf8").catch(() => ({
      applied: false,
      reason: "write_failed",
    }));
    return {
      applied: true,
      file,
      property: intent.property,
      value: intent.value,
      target: intent.target,
      patch: patched,
    };
  }
  return { applied: false, reason: "no_matching_file" };
}

/**
 * Verify parsed intents against the live page. Computed styles are the truth:
 * a stylesheet, a CSS variable, or an inline patch may all satisfy the intent.
 */
export async function runIntentChecks(page, intents = [], { viewport } = {}) {
  const out = [];
  const results = await page
    .evaluate((specs) => {
      const parseRgb = (value) => {
        const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || "");
        return match
          ? [Number(match[1]), Number(match[2]), Number(match[3])]
          : null;
      };
      const innermostByText = (text) => {
        const all = [...document.querySelectorAll("body *")].filter((el) =>
          (el.textContent || "").includes(text),
        );
        // The innermost element that still contains the text is the node a
        // user would point at; outer containers inherit, they do not own.
        return all.reverse().find((el) => el.children.length === 0) || all[0] || null;
      };
      return specs.map((spec) => {
        let el = null;
        if (spec.target.text) el = innermostByText(spec.target.text);
        else if (spec.target.tag) el = document.querySelector(spec.target.tag);
        if (!el) return { found: false };
        const computed = getComputedStyle(el)[spec.property];
        return { found: true, computed, rgb: parseRgb(computed) };
      });
    }, intents.map((intent) => ({ property: intent.property, target: intent.target })))
    .catch(() => null);

  intents.forEach((intent, i) => {
    const result = results?.[i];
    const evidence = redact({ intent: intent.raw, viewport });
    if (!result || !result.found) {
      out.push({
        issue_id: `vqa-intent-${i}-target-not-found`,
        type: "vqa-intent",
        title: "Intent target not found",
        severity: "high",
        detail: `No element matching ${JSON.stringify(intent.target)} exists on the page.`,
        evidence,
      });
      return;
    }
    const actual = result.rgb;
    const expected = intent.valueRgb;
    const matches =
      actual &&
      Math.abs(actual[0] - expected[0]) <= 2 &&
      Math.abs(actual[1] - expected[1]) <= 2 &&
      Math.abs(actual[2] - expected[2]) <= 2;
    if (!matches) {
      out.push({
        issue_id: `vqa-intent-${i}-not-applied`,
        type: "vqa-intent",
        title: "Intent change not applied",
        severity: "high",
        detail: `Expected ${intent.property} ${intent.value} (rgb ${expected.join(", ")}), computed ${result.computed || "unknown"}.`,
        evidence,
      });
    }
  });
  return out;
}
