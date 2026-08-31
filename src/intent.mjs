// Visual QA - intent-driven style changes with verified application.
//
// The intent catalog is deliberately small and fully verifiable: every
// supported instruction maps to one CSS property, one resolvable value, and
// one computed-style readback that proves the change in a fresh exploration.
// An instruction the parser cannot FULLY understand must return null and be
// reported as unparsed - never patched against a guessed target.

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

// Catalog: kind -> CSS write property + computed readback property. Shorthand
// properties are verified on one concrete longhand (padding -> padding-top)
// because computed shorthands are unreliable across engines.
const KIND_RULES = [
  {
    kind: "background-color",
    re: /(background|hintergrund)/,
    write: "background-color",
    verify: "backgroundColor",
    color: true,
  },
  {
    kind: "color",
    re: /(\bcolor\b|farbe)/,
    write: "color",
    verify: "color",
    color: true,
  },
  {
    kind: "font-size",
    re: /(font[- ]?size|schriftgr(o|ö|oe)(ss|ß)e)/,
    write: "font-size",
    verify: "fontSize",
    unit: "px",
  },
  {
    kind: "gap",
    re: /(\bgap\b|abstand zwischen)/,
    write: "gap",
    verify: "rowGap",
    unit: "px",
  },
  {
    kind: "padding",
    re: /(padding|innenabstand)/,
    write: "padding",
    verify: "paddingTop",
    unit: "px",
  },
  {
    kind: "margin",
    re: /(margin|au(ss|ß)enabstand)/,
    write: "margin",
    verify: "marginTop",
    unit: "px",
  },
];

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

function resolveColor(raw) {
  const hex = /#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/i.exec(raw);
  if (hex) return { value: hex[0], valueRgb: hexToRgb(hex[0]) };
  const fn = /rgba?\(\s*\d+[\s,]+\d+[\s,]+\d+[^)]*\)/i.exec(raw);
  if (fn) {
    const value = fn[0].replace(/\s+/g, "");
    return { value, valueRgb: rgbFromValue(value) };
  }
  const named = /\b(?:auf|to)\s+([a-zäöüß]+)\s*$/i.exec(raw);
  if (named && NAMED_COLORS[named[1].toLowerCase()])
    return {
      value: named[1],
      valueRgb: NAMED_COLORS[named[1].toLowerCase()],
    };
  return null;
}

function resolvePx(raw) {
  const px = /(?:auf|to)\s*(\d+(?:\.\d+)?)\s*px\b/i.exec(raw);
  if (!px) return null;
  return { value: `${px[1]}px`, valuePx: Number(px[1]) };
}

/**
 * Parse one catalog instruction. Returns null for anything it does not fully
 * understand - an unparsed intent must fail loudly downstream, not patch a
 * guessed target.
 */
export function parseIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const rule = KIND_RULES.find((entry) => entry.re.test(lower));
  if (!rule) return null;

  const resolved = rule.color ? resolveColor(raw) : resolvePx(raw);
  if (!resolved) return null;

  // Target: quoted text beats a tag alias after von/des/der/dem/of/the.
  const quotedTarget = /(?:von|of|in)\s+["']([^"']+)["']/i.exec(raw);
  let target = null;
  if (quotedTarget) target = { text: quotedTarget[1] };
  else {
    const tagTarget =
      /(?:von|of|des|der|dem|the)\s+(?:den\s+|die\s+|das\s+|dem\s+)?([a-zäöüß]+)\b/i.exec(
        raw,
      );
    const tag = tagTarget && TAG_ALIASES[tagTarget[1].toLowerCase()];
    if (tag) target = { tag };
  }
  if (!target) return null;

  return {
    kind: rule.kind,
    property: rule.write,
    verifyProperty: rule.verify,
    value: resolved.value,
    valueRgb: resolved.valueRgb ?? null,
    valuePx: resolved.valuePx ?? null,
    target,
    raw,
  };
}

function stylePatch(tagOpen, property, value) {
  const styleMatch = /(\sstyle\s*=\s*)(["'])(.*?)\2/i.exec(tagOpen);
  if (styleMatch) {
    const merged = `${styleMatch[1]}${styleMatch[2]}${styleMatch[3].replace(
      /;\s*$/,
      "",
    )};${property}:${value}${styleMatch[2]}`;
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
    // CSS understands neither "grün" nor locale words: the intent record keeps
    // the human value, the patch always carries a resolvable CSS value.
    const cssValue = intent.valueRgb
      ? `rgb(${intent.valueRgb.join(", ")})`
      : intent.value;
    const patched = stylePatch(tagOpen, intent.property, cssValue);
    if (patched === tagOpen) return { applied: false, reason: "patch_failed" };
    const next = `${html.slice(0, index)}${patched}${html.slice(index + tagOpen.length)}`;
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
 * Colors compare per channel (+/-2), px values compare with 1px tolerance.
 */
export async function runIntentChecks(page, intents = [], { viewport } = {}) {
  const out = [];
  const results = await page
    .evaluate(
      (specs) => {
        const parseRgb = (value) => {
          const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || "");
          return match
            ? [Number(match[1]), Number(match[2]), Number(match[3])]
            : null;
        };
        const parsePx = (value) => {
          const match = /^(-?\d+(?:\.\d+)?)px$/.exec(
            String(value || "").trim(),
          );
          return match ? Number(match[1]) : null;
        };
        const innermostByText = (text) => {
          const all = [...document.querySelectorAll("body *")].filter((el) =>
            (el.textContent || "").includes(text),
          );
          // The innermost element that still contains the text is the node a
          // user would point at; outer containers inherit, they do not own.
          return (
            all.reverse().find((el) => el.children.length === 0) ||
            all[0] ||
            null
          );
        };
        return specs.map((spec) => {
          let el = null;
          if (spec.target.text) el = innermostByText(spec.target.text);
          else if (spec.target.tag)
            el = document.querySelector(spec.target.tag);
          if (!el) return { found: false };
          const computed = getComputedStyle(el)[spec.verifyProperty];
          return {
            found: true,
            computed,
            rgb: parseRgb(computed),
            px: parsePx(computed),
          };
        });
      },
      intents.map((intent) => ({
        verifyProperty: intent.verifyProperty,
        target: intent.target,
      })),
    )
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
    let matches = false;
    let actual = result.computed || "unknown";
    if (intent.valueRgb && result.rgb) {
      matches =
        Math.abs(result.rgb[0] - intent.valueRgb[0]) <= 2 &&
        Math.abs(result.rgb[1] - intent.valueRgb[1]) <= 2 &&
        Math.abs(result.rgb[2] - intent.valueRgb[2]) <= 2;
      actual = `rgb(${result.rgb.join(", ")})`;
    } else if (intent.valuePx != null && result.px != null) {
      matches = Math.abs(result.px - intent.valuePx) <= 1;
      actual = `${result.px}px`;
    }
    if (!matches) {
      out.push({
        issue_id: `vqa-intent-${i}-not-applied`,
        type: "vqa-intent",
        title: "Intent change not applied",
        severity: "high",
        detail: `Expected ${intent.property} ${intent.value}, computed ${actual}.`,
        evidence,
      });
    }
  });
  return out;
}

/**
 * Dry-run one parsed intent against the static sources under fixDir:
 * is the target present, and in which file would the patch land? No browser,
 * no writes - this is the catalog check a harness calls before a real run.
 */
export async function dryRunIntent(intent, fixDir) {
  if (!intent) return { parsed: false };
  if (!fixDir) return { parsed: true, found: false, reason: "no_fix_dir" };
  const files = await htmlFiles(fixDir);
  for (const file of files) {
    let html;
    try {
      html = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (intent.target.text) {
      if (html.includes(intent.target.text))
        return { parsed: true, found: true, file, target: intent.target };
    } else if (intent.target.tag) {
      for (const tag of intent.target.tag.split(",")) {
        if (new RegExp(`<${tag}\\b`, "i").test(html))
          return { parsed: true, found: true, file, target: intent.target };
      }
    }
  }
  return { parsed: true, found: false, reason: "target_not_in_sources" };
}
