// Visual QA - geometry checks.
//
// What a person measures by hand when a page "looks off": is the thing above the fold, does a
// fixed bar cover content, does a neighbour jump, are edges one pixel off, does text fit its box,
// do the texts of a row keep their distance and baseline, is a tap target big enough. Every check
// measures the rendered page (boxes, text ranges, elementFromPoint) and answers with a number in px
// and, per finding, one image with the box outlined. Checks run across a width sweep, each width a
// fresh page, so "only at 411 px" is found and reported as a range, not as 29 findings.
//
// Page-side functions below are serialised as text (see measure()): they must not reach outside
// themselves. Everything they share lives in pageKit().

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { assertReachable, settle } from "./baseline.mjs";
import { issue } from "./checks.mjs";
import { DEFAULT_VIEWPORTS } from "./config.mjs";
import { safeName } from "./files.mjs";
import { sessionHooks } from "./session.mjs";

export const GEOMETRY_CHECKS = ["first-view", "covered", "stable", "edges", "text-fit", "row-align", "tap-size"];
/** Checks that need the caller to name something: the elements that must be above the fold, the trigger that must not shift. */
const NEEDS_SELECTOR = ["first-view", "stable"];
/** What runs without being told where to look. */
export const DEFAULT_GEOMETRY_CHECKS = GEOMETRY_CHECKS.filter((name) => !NEEDS_SELECTOR.includes(name));
export const GEOMETRY_SCHEMA = "vqa-geometry-0.1";
export const DEFAULTS = {
  height: 800,
  step: 40,
  /** text boxes of one row closer than this (px) are a finding */
  minGap: 6,
  /** tap-size runs at and below this viewport width (iPad Air portrait: 820) */
  touchMax: 820,
  /** a tap target smaller than this (px) in either direction is a finding */
  tapMin: 44,
  /** stable: an element that moves by more than this (px) between two states is a finding */
  moveTol: 1,
  /** per check and kind, the worst this many findings of one page are kept; the report says how many were found */
  maxPerKind: 100,
  /** covered scrolls to every content element (and a third as many controls); a page with more is not measured to the end and blocks */
  coveredMax: 10000,
};
const MAX_IMAGES = 40;
const MAX_ROWS = 10;
const IMAGE_FILE = /^\d{2,}-[a-z-]+-.*\.png$/;
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
/** Kinds whose number shrinks as the defect grows: a gap, a tap area. For every other kind the larger number is the worse one. */
const SMALLER_IS_WORSE = new Set(["gap", "small"]);
/** Is hit `a` worse than hit `b`? Both of one kind: the number, in the direction of that kind (severity follows it). */
const worseThan = (a, b) => (SMALLER_IS_WORSE.has(a.kind) ? a.value < b.value : a.value > b.value);

// ---------------------------------------------------------------- options

/** "320-1440:40" or "320-1440" → { from, to, step } (step defaults to 40). */
export function parseSweep(text) {
  const match = /^(\d+)-(\d+)(?::(\d+))?$/.exec(String(text).trim());
  if (!match) throw new Error(`sweep "${text}" must look like FROM-TO or FROM-TO:STEP, for example 320-1440:40`);
  const [from, to] = [Number(match[1]), Number(match[2])];
  const step = match[3] === undefined ? DEFAULTS.step : Number(match[3]);
  if (from < 200 || to < from) throw new Error(`sweep "${text}": FROM must be at least 200 and TO at least FROM`);
  if (step < 1) throw new Error(`sweep "${text}": STEP must be at least 1`);
  return { from, to, step };
}

/** The widths a sweep visits; TO is always included. */
export function sweepWidths({ from, to, step }) {
  const widths = [];
  for (let w = from; w < to; w += step) widths.push(w);
  widths.push(to);
  return widths;
}

/** ["first-view=.hero h1", "stable=hover:.menu"] → { "first-view": [".hero h1"], stable: ["hover:.menu"] }. */
export function parseSelectorFlags(flags = []) {
  const out = {};
  for (const flag of flags) {
    const at = String(flag).indexOf("=");
    const check = at < 0 ? "" : flag.slice(0, at).trim();
    const css = at < 0 ? "" : flag.slice(at + 1).trim();
    if (!NEEDS_SELECTOR.includes(check) || !css)
      throw new Error(`--selector "${flag}" must look like first-view=CSS or stable=CSS (stable=hover:CSS to hover instead of click)`);
    (out[check] ??= []).push(css);
  }
  return out;
}

/** "covered,edges" → ["covered","edges"]; unknown names and checks that lack their selector are an error. */
export function resolveChecks(text, selectors = {}) {
  const named = text === undefined || text === null ? null : String(text).split(",").map((s) => s.trim()).filter(Boolean);
  if (named) {
    const unknown = named.find((name) => !GEOMETRY_CHECKS.includes(name));
    if (unknown) throw new Error(`unknown geometry check "${unknown}"; known: ${GEOMETRY_CHECKS.join(", ")}`);
    const lacking = named.find((name) => NEEDS_SELECTOR.includes(name) && !selectors[name]?.length);
    if (lacking) throw new Error(`check "${lacking}" needs --selector ${lacking}=CSS`);
    return [...new Set(named)];
  }
  return [...DEFAULT_GEOMETRY_CHECKS, ...NEEDS_SELECTOR.filter((name) => selectors[name]?.length)];
}

// ---------------------------------------------------------------- in the page

/** Shared helpers of every page-side check. Returns the kit; written as a function so it can be sent as text. */
function pageKit() {
  const round = (n) => Math.round(n * 10) / 10;
  const VIS = { checkOpacity: true, checkVisibilityCSS: true };
  const shown = (el, min = 1) => {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= min && r.height >= min && el.checkVisibility(VIS);
  };
  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.left + scrollX), y: round(r.top + scrollY), w: round(r.width), h: round(r.height) };
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      if (n === document.documentElement) break;
      if (n === document.body) {
        parts.unshift("body");
        break;
      }
      if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      let part = n.tagName.toLowerCase();
      const testId = n.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`${part}[data-testid="${testId}"]`);
        break;
      }
      if (typeof n.className === "string")
        part += n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const snippet = (el) =>
    String(el.innerText || el.getAttribute("aria-label") || el.value || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const stuck = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const position = getComputedStyle(n).position;
      if (position === "fixed" || position === "sticky") return n;
    }
    return null;
  };
  const canvas = document.createElement("canvas").getContext("2d");
  const ascents = new Map();
  const ascentOf = (host) => {
    const cs = getComputedStyle(host);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (!ascents.has(font)) {
      canvas.font = font;
      ascents.set(font, canvas.measureText("M").fontBoundingBoxAscent ?? 0);
    }
    return ascents.get(font);
  };
  /** The lines of an element's text as boxes {l,r,t,b,base,size} (viewport px): what a reader sees, not the CSS box. */
  const textLines = (el) => {
    const rects = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const host = n.parentElement;
      if (!host || !host.checkVisibility(VIS)) continue;
      const box = host.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue; // visually hidden text
      const range = document.createRange();
      range.selectNodeContents(n);
      const size = parseFloat(getComputedStyle(host).fontSize) || 0;
      for (const q of range.getClientRects())
        if (q.width > 0 && q.height > 0)
          rects.push({ l: q.left, r: q.right, t: q.top, b: q.bottom, base: q.top + ascentOf(host), size });
    }
    rects.sort((a, b) => a.t - b.t || a.l - b.l);
    const lines = [];
    for (const q of rects) {
      const last = lines[lines.length - 1];
      if (last && Math.min(last.b, q.b) - Math.max(last.t, q.t) > 0.5 * Math.min(last.b - last.t, q.b - q.t)) {
        if (q.size >= last.size) {
          last.base = q.base;
          last.size = q.size;
        }
        last.l = Math.min(last.l, q.l);
        last.r = Math.max(last.r, q.r);
        last.t = Math.min(last.t, q.t);
        last.b = Math.max(last.b, q.b);
      } else lines.push({ ...q });
    }
    return lines;
  };
  /** Pages can be bigger than a check is willing to walk: what a check leaves out is recorded, never dropped silently. */
  const caps = [];
  const take = (list, limit, label) => {
    if (list.length > limit) caps.push({ label, seen: list.length, kept: limit });
    return list.slice(0, limit);
  };
  const toTop = () => {
    scrollTo(0, 0);
    for (const el of document.querySelectorAll("body, body *")) if (el.scrollTop) el.scrollTop = 0;
  };
  const modalOpen = () => {
    try {
      return !!document.querySelector('dialog:modal, [aria-modal="true"]');
    } catch {
      return false;
    }
  };
  return { round, shown, docRect, selectorOf, snippet, stuck, textLines, toTop, modalOpen, caps, take };
}

/** first-view: every element matching a selector lies wholly above the fold of this viewport. */
function inFirstView(kit, { selectors }) {
  const out = [];
  const fold = innerHeight;
  for (const css of selectors) {
    let found;
    try {
      found = [...document.querySelectorAll(css)];
    } catch {
      out.push({ kind: "bad-selector", severity: "high", selector: css, value: 0, message: `"${css}" is not a valid CSS selector` });
      continue;
    }
    const visible = found.filter((el) => kit.shown(el));
    if (!visible.length) {
      out.push({
        kind: "not-found",
        severity: "high",
        selector: css,
        value: 0,
        message: found.length ? `"${css}" matches ${found.length} element(s), none visible at this size` : `"${css}" matches nothing on the page`,
      });
      continue;
    }
    for (const el of visible) {
      const r = el.getBoundingClientRect();
      const below = r.bottom - fold;
      if (below > 0.5)
        out.push({
          kind: "below-fold",
          severity: "high",
          selector: visible.length > 1 ? kit.selectorOf(el) : css,
          text: kit.snippet(el),
          value: kit.round(below),
          measure: { fold, bottom: kit.round(r.bottom) },
          message: `ends ${kit.round(below)} px below the fold (bottom ${kit.round(r.bottom)} px, window ${fold} px high)`,
          scroll: "top",
          fold,
        });
    }
  }
  return out;
}

/**
 * covered: a fixed or sticky element lies over content that no scrolling clears (the browser's best reveal, centred,
 * is clamped at the page ends and never gets past a side rail), or over a control once the browser scrolls it into
 * view as it does on focus. A bar over content that scrolls out from under it is not a finding.
 */
function inCovered(kit, { max }) {
  if (kit.modalOpen()) return []; // a modal covers the page on purpose
  const positioned = [...document.querySelectorAll("body *")].filter((el) => {
    const position = getComputedStyle(el).position;
    return (position === "fixed" || position === "sticky") && kit.shown(el, 2);
  });
  if (!positioned.length) return [];
  const content = "h1,h2,h3,h4,p,li,label,img,a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex='-1'])";
  const control = "a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex='-1'])";
  const targets = [...document.querySelectorAll(content)].filter((el) => kit.shown(el, 4) && !kit.stuck(el));
  const worst = new Map();
  const probe = (el, phase) => {
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return;
    const at = (fx, fy) => {
      const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width * fx));
      const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height * fy));
      const top = document.elementFromPoint(x, y);
      if (!top || el.contains(top) || top.contains(el)) return null;
      const bar = kit.stuck(top);
      return bar && !bar.contains(el) ? bar : null;
    };
    const centre = at(0.5, 0.5);
    if (!centre) return;
    let covered = 0;
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) if (at(fx, fy)) covered += 1;
    const pct = Math.round((covered / 25) * 100);
    const old = worst.get(el);
    if (!old || pct > old.value)
      worst.set(el, {
        kind: phase === "focus" ? "covers-focus" : "covers-content",
        severity: "high",
        selector: kit.selectorOf(el),
        selector2: kit.selectorOf(centre),
        text: kit.snippet(el),
        value: pct,
        unit: "%",
        measure: { covered_by: kit.selectorOf(centre) },
        message: phase === "focus"
          ? `${pct} % of it lies under ${kit.selectorOf(centre)} once the browser has scrolled it into view`
          : `${pct} % of it lies under ${kit.selectorOf(centre)} wherever the page is scrolled`,
        scroll: phase === "focus" ? "nearest" : "center",
      });
  };
  for (const el of kit.take(targets, max, "content elements")) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    probe(el, "reveal");
  }
  for (const el of kit.take(targets.filter((e) => e.matches(control)), Math.ceil(max / 3), "controls")) {
    scrollTo(0, 0);
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    probe(el, "focus");
  }
  kit.toTop();
  return [...worst.values()];
}

/** stable, first half: remember where everything is (document coordinates, so scrolling does not matter). */
function inStableBefore(kit) {
  window.__vqaStable = [...document.querySelectorAll("body *")].filter((el) => kit.shown(el)).map((el) => [el, kit.docRect(el)]);
}

/** stable, second half: who moved? Elements inside or around the trigger do not count. Topmost mover only. */
function inStableAfter(kit, { trigger, tol }) {
  // No earlier state means the page was replaced (the trigger navigated or reloaded): nothing to compare, and not "nothing moved".
  if (!window.__vqaStable) throw new Error("the page was replaced after the trigger (it navigated or reloaded): there is no earlier state to compare");
  const seen = window.__vqaStable;
  delete window.__vqaStable;
  const trig = document.querySelector(trigger);
  const moved = new Map();
  for (const [el, before] of seen) {
    if (!el.isConnected || !kit.shown(el)) continue;
    if (trig && (trig.contains(el) || el.contains(trig))) continue;
    const now = kit.docRect(el);
    const dx = kit.round(now.x - before.x);
    const dy = kit.round(now.y - before.y);
    if (Math.abs(dx) > tol || Math.abs(dy) > tol) moved.set(el, { dx, dy, before, now });
  }
  const out = [];
  for (const [el, m] of moved) {
    const up = el.parentElement ? moved.get(el.parentElement) : null;
    if (up && Math.abs(up.dx - m.dx) <= 0.5 && Math.abs(up.dy - m.dy) <= 0.5) continue;
    const value = Math.max(Math.abs(m.dx), Math.abs(m.dy));
    out.push({
      kind: "moves",
      severity: "medium",
      selector: kit.selectorOf(el),
      text: kit.snippet(el),
      value,
      measure: { dx: m.dx, dy: m.dy },
      message: `moved ${m.dx} px right, ${m.dy} px down when ${trigger} changed the page`,
      before: m.before,
      scroll: "center",
    });
  }
  return out;
}

/** edges: stacked boxes whose left edges (or, for surfaces, right edges) are 1 to 4 px apart: almost flush, but not. */
function inEdges(kit) {
  const out = [];
  const BLOCKS = ["block", "flex", "grid", "list-item", "table", "flow-root"];
  const surface = (cs) => !/^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/.test(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0;
  for (const parent of new Set([...document.querySelectorAll("body *")].map((el) => el.parentElement))) {
    if (!parent) continue;
    const pcs = getComputedStyle(parent);
    if (pcs.textAlign === "center" || (/flex|grid/.test(pcs.display) && (pcs.justifyContent === "center" || pcs.alignItems === "center"))) continue;
    const kids = [...parent.children].filter((el) => {
      if (!kit.shown(el, 4)) return false;
      const cs = getComputedStyle(el);
      return BLOCKS.includes(cs.display) && cs.position !== "absolute" && cs.position !== "fixed";
    });
    for (let i = 1; i < kids.length; i += 1) {
      const a = kids[i - 1].getBoundingClientRect();
      const b = kids[i].getBoundingClientRect();
      const stacked = b.top >= a.bottom - 1 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 20;
      if (!stacked) continue;
      const left = Math.abs(a.left - b.left);
      const right = Math.abs(a.right - b.right);
      const bothSurfaces = surface(getComputedStyle(kids[i - 1])) && surface(getComputedStyle(kids[i]));
      const side = left >= 1 && left <= 4 ? ["left", left] : bothSurfaces && right >= 1 && right <= 4 ? ["right", right] : null;
      if (!side) continue;
      out.push({
        kind: `${side[0]}-edge`,
        severity: "medium",
        selector: kit.selectorOf(kids[i]),
        selector2: kit.selectorOf(kids[i - 1]),
        text: kit.snippet(kids[i]),
        value: kit.round(side[1]),
        message: `${side[0]} edge ${kit.round(side[1])} px off the box above it (${kit.selectorOf(kids[i - 1])})`,
        scroll: "center",
      });
    }
  }
  return out;
}

/** text-fit: text cut off by its box, an ellipsis nobody can read in full, text sticking out of its box. */
function inTextFit(kit) {
  const out = [];
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  for (const el of document.querySelectorAll("body *")) {
    if (["INPUT", "SELECT", "TEXTAREA", "SVG", "SCRIPT", "STYLE", "OPTION"].includes(el.tagName.toUpperCase())) continue;
    if (!ownText(el) || !kit.shown(el, 4)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "inline" || cs.display === "contents") continue;
    const box = el.getBoundingClientRect();
    const lines = kit.textLines(el);
    if (!lines.length) continue;
    const textRight = Math.max(...lines.map((l) => l.r));
    const textBottom = Math.max(...lines.map((l) => l.b));
    const edgeRight = box.right - parseFloat(cs.borderRightWidth);
    const hardX = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const hardY = cs.overflowY === "hidden" || cs.overflowY === "clip";
    const scrolls = cs.overflowX === "auto" || cs.overflowX === "scroll";
    const titled = !!(el.closest("[title]") || el.getAttribute("aria-label"));
    const hit = (kind, severity, value, message) =>
      out.push({ kind, severity, selector: kit.selectorOf(el), text: kit.snippet(el), value: kit.round(value), message, scroll: "center" });
    if (hardX && el.scrollWidth > el.clientWidth + 1 && textRight > edgeRight + 1) {
      const cut = kit.round(textRight - edgeRight);
      if (cs.textOverflow === "ellipsis") {
        if (!titled) hit("ellipsis-no-title", "medium", cut, `text is shortened with an ellipsis (${cut} px cut) and has no title or aria-label with the full text`);
      } else hit("text-cut", "high", cut, `text is cut off by its box (${cut} px of the text lie outside)`);
    } else if (hardY && el.scrollHeight > el.clientHeight + 1 && (textBottom > box.bottom + 1 || cs.webkitLineClamp !== "none")) {
      const cut = kit.round(el.scrollHeight - el.clientHeight);
      if (cs.webkitLineClamp !== "none") {
        if (!titled) hit("ellipsis-no-title", "medium", cut, `text is clamped to ${cs.webkitLineClamp} line(s) (${cut} px hidden) and has no title or aria-label with the full text`);
      } else hit("text-cut", "high", cut, `text is cut off by its box (${cut} px of the text lie below it)`);
    } else if (!hardX && !scrolls && textRight > edgeRight + 1) {
      const beyond = kit.round(textRight - edgeRight);
      hit("text-overflow", "medium", beyond, `text sticks out of its box by ${beyond} px`);
    }
  }
  return out;
}

/** row-align: texts that sit on one line must keep their distance, and equally sized ones a common baseline. */
function inRowAlign(kit, { minGap }) {
  const out = [];
  // A table row is not a box of its own: its cells are, and a cell that spans rows has its text between them.
  const ROW_PARTS = /^table-(row|row-group|header-group|footer-group|column|column-group)$/;
  for (const parent of document.querySelectorAll("body, body *")) {
    const kids = [...parent.children]
      .filter((el) => {
        if (!kit.shown(el, 2)) return false;
        const cs = getComputedStyle(el);
        return cs.display !== "inline" && cs.display !== "contents" && !ROW_PARTS.test(cs.display) && cs.position !== "absolute" && cs.position !== "fixed";
      })
      .map((el) => ({ el, lines: kit.textLines(el) }))
      .filter((k) => k.lines.length);
    if (kids.length < 2) continue;
    // Only boxes whose texts share some height can be on one line: walk them top to bottom, not every pair of a long list.
    for (const k of kids) {
      k.top = Math.min(...k.lines.map((l) => l.t));
      k.bottom = Math.max(...k.lines.map((l) => l.b));
    }
    const byTop = kids.map((_, i) => i).sort((x, y) => kids[x].top - kids[y].top);
    const pairs = [];
    for (let p = 0; p < byTop.length; p += 1)
      for (let q = p + 1; q < byTop.length && kids[byTop[q]].top < kids[byTop[p]].bottom; q += 1)
        pairs.push([Math.min(byTop[p], byTop[q]), Math.max(byTop[p], byTop[q])]);
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    for (const [i, j] of pairs) {
      let found = null;
      for (const a of kids[i].lines) {
        for (const b of kids[j].lines) {
          const overlap = Math.min(a.b, b.b) - Math.max(a.t, b.t);
          if (overlap <= 0.5 * Math.min(a.b - a.t, b.b - b.t)) continue;
          const [left, right] = a.l <= b.l ? [a, b] : [b, a];
          const gap = right.l - left.r;
          if (gap < minGap && (!found || gap < found.gap)) found = { gap, a, b };
        }
      }
      const [first, second] = [kids[i], kids[j]];
      if (found)
        out.push({
          kind: "gap",
          severity: found.gap < 0 ? "high" : "medium",
          selector: kit.selectorOf(second.el),
          selector2: kit.selectorOf(first.el),
          text: kit.snippet(second.el),
          value: kit.round(found.gap),
          message: `${found.gap < 0 ? "overlaps" : "is only " + kit.round(found.gap) + " px from"} the text of ${kit.selectorOf(first.el)} on the same line (minimum ${minGap} px)`,
          scroll: "center",
        });
      // Same text size, same line, baselines 1 px or more apart: nearly aligned, not aligned. Only boxes of as many lines
      // as each other are compared: a centred or bottom-aligned neighbour of a taller text is placed so, not misaligned.
      const [a, b] = [first.lines[0], second.lines[0]];
      const sameLine = Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5 * Math.min(a.b - a.t, b.b - b.t);
      const off = Math.abs(a.base - b.base);
      const spans = first.el.rowSpan > 1 || second.el.rowSpan > 1;
      if (!spans && first.lines.length === second.lines.length && sameLine && Math.abs(a.size - b.size) <= 1 && off >= 1 && off <= 0.5 * Math.min(a.b - a.t, b.b - b.t))
        out.push({
          kind: "baseline",
          severity: off < 2 ? "low" : "medium",
          selector: kit.selectorOf(second.el),
          selector2: kit.selectorOf(first.el),
          text: kit.snippet(second.el),
          value: kit.round(off),
          message: `baseline ${kit.round(off)} px off the text of ${kit.selectorOf(first.el)} on the same line (same text size)`,
          scroll: "center",
        });
    }
  }
  return out;
}

/** tap-size: the area that answers a tap (box, label, ::after reach — measured with elementFromPoint) and overlaps between targets. */
function inTapSize(kit, { min }) {
  const out = [];
  const targets = [
    ...document.querySelectorAll(
      "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem]",
    ),
  ].filter((el) => {
    if (!kit.shown(el, 2) || el.disabled) return false; // a 1 px clip is a skip link waiting for focus, not a target
    // A link inside a sentence is exempt (WCAG 2.5.8 inline exception): the text of its nearest block, through
    // inline wrappers such as <sup> or <em>, is more than the link itself.
    if (el.tagName === "A" && getComputedStyle(el).display === "inline") {
      let block = el.parentElement;
      while (block && getComputedStyle(block).display === "inline") block = block.parentElement;
      const around = (block?.textContent ?? "").trim().length - (el.textContent ?? "").trim().length;
      if (around > 12) return false;
    }
    return true;
  });
  const reach = (el, cx, cy) => {
    const own = (top) => top && (top === el || el.contains(top) || [...(el.labels ?? [])].some((l) => l === top || l.contains(top)));
    const walk = (dx, dy) => {
      let n = 0;
      while (n < min && own(document.elementFromPoint(cx + dx * (n + 1), cy + dy * (n + 1)))) n += 1;
      return n;
    };
    return { w: walk(-1, 0) + walk(1, 0) + 1, h: walk(0, -1) + walk(0, 1) + 1 };
  };
  // Overlap is a question of where boxes are at one scroll position. Every box is taken before the first scroll below, and
  // only boxes that scroll together are compared: the same fixed sheet, the same scroller. A box in a sheet and one on the
  // page behind it are not on one surface.
  const ids = new Map();
  const idOf = (node) => (node ? ids.get(node) ?? ids.set(node, ids.size + 1).get(node) : 0);
  const scrollerOf = (el) => {
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement)
      if (/auto|scroll|overlay|hidden|clip/.test(getComputedStyle(n).overflowX + getComputedStyle(n).overflowY)) return n;
    return null;
  };
  const boxes = targets.map((el, order) => {
    const r = el.getBoundingClientRect();
    return { el, order, x: r.left, y: r.top, w: r.width, h: r.height, surface: `${idOf(kit.stuck(el))}|${idOf(scrollerOf(el))}` };
  });
  for (const box of boxes) {
    const { el } = box;
    let { w, h } = box;
    if (w < min || h < min) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const now = el.getBoundingClientRect();
      const seen = reach(el, now.left + now.width / 2, now.top + now.height / 2);
      w = Math.max(w, seen.w);
      h = Math.max(h, seen.h);
    }
    if (w >= min && h >= min) continue;
    const small = Math.min(w, h);
    out.push({
      kind: "small",
      severity: small < 24 ? "high" : "medium",
      selector: kit.selectorOf(el),
      text: kit.snippet(el),
      value: kit.round(small),
      measure: { width: kit.round(w), height: kit.round(h), minimum: min },
      message: `tap area ${kit.round(w)} × ${kit.round(h)} px, below ${min} px`,
      scroll: "center",
    });
  }
  const bySurface = new Map();
  for (const box of boxes) bySurface.set(box.surface, [...(bySurface.get(box.surface) ?? []), box]);
  for (const surface of bySurface.values()) {
    surface.sort((p, q) => p.y - q.y);
    for (let i = 0; i < surface.length; i += 1) {
      for (let j = i + 1; j < surface.length && surface[j].y < surface[i].y + surface[i].h - 2; j += 1) {
        const [a, b] = surface[i].order < surface[j].order ? [surface[i], surface[j]] : [surface[j], surface[i]];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if ([...(a.el.labels ?? [])].includes(b.el) || [...(b.el.labels ?? [])].includes(a.el)) continue;
        const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ow < 2 || oh < 2) continue;
        out.push({
          kind: "overlap",
          severity: "high",
          selector: kit.selectorOf(b.el),
          selector2: kit.selectorOf(a.el),
          text: kit.snippet(b.el),
          value: kit.round(Math.min(ow, oh)),
          measure: { width: kit.round(ow), height: kit.round(oh) },
          message: `tap area overlaps ${kit.selectorOf(a.el)} by ${kit.round(ow)} × ${kit.round(oh)} px`,
          scroll: "center",
        });
      }
    }
  }
  kit.toTop();
  return out;
}

/** Outline the finding in the page (fixed overlays), scroll as the check did, say which part of the viewport to photograph. */
function inMark(kit, { selector, selector2, scroll, fold, before }) {
  const find = (css) => {
    try {
      return css ? [...document.querySelectorAll(css)].find((el) => kit.shown(el)) ?? null : null;
    } catch {
      return null;
    }
  };
  const el = find(selector);
  if (scroll === "top") kit.toTop();
  else if (el) el.scrollIntoView({ block: scroll === "nearest" ? "nearest" : "center", inline: "nearest" });
  const layer = document.createElement("div");
  layer.id = "__vqa-geometry-mark";
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const draw = (r, colour, dashed) => {
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;height:${r.height + 4}px;outline:3px ${dashed ? "dashed" : "solid"} ${colour};background:${dashed ? "transparent" : "rgba(255,0,255,.12)"}`;
    layer.append(box);
  };
  const rect = el?.getBoundingClientRect() ?? null;
  const rect2 = find(selector2)?.getBoundingClientRect() ?? null;
  if (rect2) draw(rect2, "#ff8800", true);
  if (before) draw({ left: before.x - scrollX, top: before.y - scrollY, width: before.w, height: before.h }, "#ff8800", true);
  if (rect) draw(rect, "#ff00ff", false);
  if (fold) {
    const line = document.createElement("div");
    line.style.cssText = `position:fixed;left:0;right:0;top:${fold - 1}px;height:2px;background:#ff0000`;
    layer.append(line);
  }
  document.documentElement.append(layer);
  const view = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  // Below the fold: photograph the page down to the box, the fold as a red line.
  if (fold && rect && rect.bottom > fold) {
    const end = Math.ceil(rect.bottom) + 40;
    // The picture stops at 2400 px: say where the box is when it lies below that.
    const note = end > 2400 ? `the box lies ${kit.round(rect.top + scrollY)}–${kit.round(rect.bottom + scrollY)} px down the page, below the 2400 px this picture shows (the red line is the fold)` : null;
    return { clip: { ...view, height: Math.min(end, 2400) }, full: true, note };
  }
  if (fold || rect2 || before || !rect) return { clip: view, full: false };
  const pad = 80;
  const x = Math.max(0, rect.left - pad);
  const y = Math.max(0, rect.top - pad);
  return {
    clip: {
      x,
      y,
      width: Math.max(360, Math.min(innerWidth - x, rect.width + 2 * pad)),
      height: Math.max(220, Math.min(innerHeight - y, rect.height + 2 * pad)),
    },
    full: false,
  };
}

function inUnmark() {
  document.getElementById("__vqa-geometry-mark")?.remove();
}

const IN_PAGE = {
  "first-view": inFirstView,
  covered: inCovered,
  edges: inEdges,
  "text-fit": inTextFit,
  "row-align": inRowAlign,
  "tap-size": inTapSize,
};

/**
 * Run a page-side function with the kit and a JSON argument. Sent as text, so a page's CSP cannot block it.
 * Answers { value, caps }: what the function returned, and what it left out because the page was bigger than it walks.
 */
function measure(page, fn, arg = null) {
  return page.evaluate(`(() => { const kit = (${pageKit})(); const value = (${fn})(kit, ${JSON.stringify(arg)}); return { value, caps: kit.caps }; })()`);
}

/** Keep the worst `perKind` hits of each kind; what is left out is named, so a long list never reads as the whole list. */
function keepWorst(check, hits, perKind) {
  const byKind = new Map();
  for (const hit of hits) byKind.set(hit.kind, [...(byKind.get(hit.kind) ?? []), hit]);
  const kept = [];
  const truncated = [];
  for (const [kind, list] of byKind) {
    if (list.length > perKind) {
      list.sort((a, b) => (worseThan(a, b) ? -1 : worseThan(b, a) ? 1 : 0));
      truncated.push({ check, cut: "findings", label: kind, seen: list.length, kept: perKind });
    }
    kept.push(...list.slice(0, perKind));
  }
  return { hits: kept, truncated };
}

// ---------------------------------------------------------------- one page, one width

const clipOf = (box) => ({ x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.max(1, box.width), height: Math.max(1, box.height) });

/** Arguments of each check from the options. */
function argsFor(check, options) {
  if (check === "first-view") return { selectors: options.selectors["first-view"] ?? [] };
  if (check === "covered") return { max: options.coveredMax };
  if (check === "row-align") return { minGap: options.minGap };
  if (check === "tap-size") return { min: options.tapMin };
  return null;
}

/**
 * Run checks on the page as it is now, at its current viewport. `stable` is not part of this: it needs a
 * trigger and a fresh page (see geometry()). A check that throws is returned as `errors`, never as "no finding".
 */
export async function runGeometryChecks(page, options = {}) {
  const opts = { ...DEFAULTS, selectors: {}, ...options };
  const width = await page.evaluate(() => window.innerWidth);
  const checks = (opts.checks ?? DEFAULT_GEOMETRY_CHECKS).filter((c) => c !== "stable");
  const hits = [];
  const errors = [];
  const skipped = [];
  const truncated = [];
  for (const check of checks) {
    if (check === "tap-size" && width > opts.touchMax) {
      skipped.push({ check, reason: `viewport ${width} px is wider than --touch-max ${opts.touchMax} px` });
      continue;
    }
    try {
      const { value, caps } = await measure(page, IN_PAGE[check], argsFor(check, opts));
      const kept = keepWorst(check, value, opts.maxPerKind);
      for (const hit of kept.hits) hits.push({ check, ...hit });
      truncated.push(...kept.truncated, ...caps.map((cap) => ({ check, cut: "targets", ...cap })));
    } catch (error) {
      errors.push({ check, message: `check failed: ${String(error?.message ?? error).split("\n")[0]}` });
    }
  }
  return { hits, errors, skipped, truncated };
}

/** Findings of runGeometryChecks as the issues the other checks produce (explore --geometry). */
export function geometryIssues(hits, { viewport = null } = {}) {
  return hits.map((hit) =>
    issue(
      "geometry",
      `${hit.check}: ${hit.selector} ${hit.message}`,
      hit.severity,
      `${hit.check} (${hit.kind}) ${hit.selector}: ${hit.message}`,
      { check: hit.check, kind: hit.kind, selector: hit.selector, text: hit.text ?? null, value: hit.value, unit: hit.unit ?? "px", viewport },
    ),
  );
}

/** One line for a cut: what a check did not look at, or which findings the report does not carry. */
const describeCut = (t) =>
  t.cut === "targets"
    ? `${t.check} measured ${t.kept} of ${t.seen} ${t.label}; the rest was not measured`
    : `${t.check}/${t.label}: the worst ${t.kept} of ${t.seen} are kept, the rest are not in the report`;

/**
 * The explore hook (--geometry): the checks that need no input, on the page as it is, as issues. A check that could not
 * run, or only ran over part of the page, is an issue too: silence would read as clean.
 */
export async function geometryFindings(page, viewport) {
  const { hits, errors, truncated } = await runGeometryChecks(page);
  return [
    ...geometryIssues(hits, { viewport }),
    ...errors.map((e) => issue("geometry", `Geometry check ${e.check} unavailable`, "medium", e.message, { check: e.check, viewport })),
    ...truncated.map((t) =>
      issue("geometry", `Geometry check ${t.check}${t.cut === "findings" ? `/${t.label}` : ""} cut short`, t.cut === "targets" ? "medium" : "low", describeCut(t), { check: t.check, viewport }),
    ),
  ];
}

// ---------------------------------------------------------------- the run

const firstLine = (error) => String(error?.message ?? error).split("\n")[0];
const widthOf = (viewport) => viewport.width;

function describeViewports({ viewports, sweep, height }) {
  const list = [];
  for (const v of viewports) list.push({ name: v.name, width: v.width, height: v.height });
  if (sweep) for (const width of sweepWidths(sweep)) list.push({ name: `w${width}`, width, height });
  if (!list.length) for (const v of DEFAULT_VIEWPORTS) list.push({ ...v });
  const seen = new Set();
  return list.filter((v) => {
    const key = `${v.width}x${v.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function openPage(browser, { viewport, target, baseUrl, session, navigationTimeoutMs, locale }) {
  const ctx = { baseUrl, state: target.state, viewport, locale };
  // Routes are visited as an anonymous visitor: the project's sign-in belongs to its states.
  const hooks = sessionHooks({ session: target.state ? session : null, def: target.def, ctx });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: "reduce",
    locale,
    serviceWorkers: "block",
    ...(hooks.storageState ? { storageState: hooks.storageState } : {}),
  });
  try {
    const page = await context.newPage();
    if (hooks.prepare) await hooks.prepare(page);
    const response = await page.goto(new URL(target.path, baseUrl).toString(), { waitUntil: "load", timeout: navigationTimeoutMs });
    if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    await settle(page);
    return { page, context };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/** Where a trigger text points: "hover:CSS" hovers, "click:CSS" or plain CSS clicks. */
function parseTrigger(text) {
  const match = /^(hover|click):(.*)$/s.exec(text);
  return match ? { how: match[1], css: match[2].trim() } : { how: "click", css: text };
}

async function runStable(page, trigger, tol) {
  const { how, css } = parseTrigger(trigger);
  const locator = page.locator(css).first();
  if (!(await locator.count())) throw new Error(`stable trigger "${css}" matches nothing`);
  // The browser scrolls the trigger into view before it clicks or hovers, and a scroller scrolled moves what is in it:
  // do that first, so only what the trigger itself changes is compared.
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await measure(page, inStableBefore);
  await locator[how === "hover" ? "hover" : "click"]({ timeout: 5_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(150);
  return (await measure(page, inStableAfter, { trigger: css, tol })).value;
}

/**
 * Measure every route/state × viewport, aggregate over the sweep, photograph each finding once at its worst
 * viewport, write report.md + report.json. Load problems land in `errors`; they never throw.
 *
 * options: baseUrl, outDir, routes, viewports [{name,width,height}], sweep {from,to,step}, height,
 * checks, selectors {first-view:[css], stable:[css]}, minGap, touchMax, tapMin, moveTol,
 * session + stateDefs (resolveSessionInput of the project config) with states [selector].
 */
export async function geometry(options = {}) {
  const baseUrl = options.baseUrl;
  if (!baseUrl) throw new Error("geometry requires --url / baseUrl");
  const opts = { ...DEFAULTS, selectors: {}, routes: [], states: [], stateDefs: {}, session: null, ...options };
  const checks = opts.checks?.length ? opts.checks : resolveChecks(undefined, opts.selectors);
  const viewports = describeViewports({ viewports: opts.viewports ?? [], sweep: opts.sweep ?? null, height: opts.height });
  // Routes, else "/" when no state is named; each state brings its own path.
  const routes = opts.routes.length ? opts.routes : opts.states.length ? [] : ["/"];
  const targets = [
    ...routes.map((route) => ({ id: route, route, state: null, def: null, path: route })),
    ...opts.states.map((selector) => ({
      id: selector, route: opts.stateDefs[selector].path, state: selector, def: opts.stateDefs[selector], path: opts.stateDefs[selector].path,
    })),
  ];
  await assertReachable(baseUrl);
  const outDir = resolve(opts.outDir ?? ".qa-geometry");
  await mkdir(join(outDir, "images"), { recursive: true });
  // An earlier run's pictures must not pass for this run's: remove what a run names, nothing else.
  for (const file of await readdir(join(outDir, "images")))
    if (IMAGE_FILE.test(file)) await rm(join(outDir, "images", file), { force: true });
  const locale = "en-US";
  const open = { baseUrl, session: opts.session, navigationTimeoutMs: opts.navigationTimeoutMs ?? 15_000, locale };

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const groups = new Map();
  const errors = [];
  const warnings = [];
  const cuts = new Map();
  const coverage = Object.fromEntries(checks.map((check) => [check, { ran: 0, of: 0 }]));
  const loaded = new Set();
  const started = Date.now();
  try {
    for (const viewport of viewports) {
      for (const target of targets) {
        const where = { route: target.route, state: target.state, viewport: viewport.name };
        let page;
        let context;
        try {
          ({ page, context } = await openPage(browser, { ...open, viewport, target }));
        } catch (error) {
          errors.push({ ...where, message: `load failed: ${firstLine(error)}` });
          continue;
        }
        loaded.add(`${target.id}`);
        try {
          const run = await runGeometryChecks(page, { ...opts, checks });
          for (const check of checks.filter((c) => c !== "stable")) {
            coverage[check].of += 1;
            const whole = !run.truncated.some((t) => t.check === check && t.cut === "targets");
            if (whole && !run.skipped.some((s) => s.check === check) && !run.errors.some((e) => e.check === check)) coverage[check].ran += 1;
          }
          for (const e of run.errors) errors.push({ ...where, ...e });
          for (const hit of run.hits) collect(groups, hit, target, viewport);
          noteCuts(cuts, run.truncated, target, viewport);
        } finally {
          await context.close().catch(() => {});
        }
        if (checks.includes("stable")) {
          coverage.stable.of += (opts.selectors.stable ?? []).length;
          for (const trigger of opts.selectors.stable ?? []) {
            let again;
            try {
              again = await openPage(browser, { ...open, viewport, target });
              const kept = keepWorst("stable", await runStable(again.page, trigger, opts.moveTol), opts.maxPerKind);
              for (const hit of kept.hits) collect(groups, { check: "stable", trigger, ...hit }, target, viewport);
              noteCuts(cuts, kept.truncated, target, viewport);
              coverage.stable.ran += 1;
            } catch (error) {
              errors.push({ ...where, check: "stable", message: `stable ${trigger}: ${firstLine(error)}` });
            } finally {
              await again?.context.close().catch(() => {});
            }
          }
        }
      }
    }
    const findings = finish(groups, opts.sweep?.step ?? 0);
    await photograph(browser, { findings, open, outDir, warnings });
    return await write({
      baseUrl, outDir, checks, viewports, targets, findings, errors, warnings, coverage, truncated: [...cuts.values()], loaded: loaded.size,
      seconds: Math.round((Date.now() - started) / 100) / 10, opts,
    });
  } finally {
    await browser.close();
  }
}

/** Group hits by what they are about; keep every width and the worst one. */
function collect(groups, hit, target, viewport) {
  const key = [hit.check, hit.kind, target.id, hit.selector, hit.selector2 ?? ""].join("|");
  const group = groups.get(key) ?? { hit, target, widths: [], worst: null };
  group.widths.push(viewport);
  if (!group.worst || worseThan(hit, group.worst.hit)) group.worst = { viewport, hit };
  groups.set(key, group);
}

/** Collect what a page's checks cut short, one line per check and thing, with the biggest page seen and where. */
function noteCuts(cuts, truncated, target, viewport) {
  for (const t of truncated) {
    const key = [t.check, t.cut, t.label, target.id].join("|");
    const old = cuts.get(key) ?? { ...t, route: target.route, state: target.state, viewports: [] };
    old.seen = Math.max(old.seen, t.seen);
    old.viewports.push(viewport.name);
    cuts.set(key, old);
  }
}

function finish(groups, step) {
  const findings = [];
  for (const { hit, target, widths, worst } of groups.values()) {
    // Widths one sweep step apart are a range; separate viewports (mobile, desktop) stay a list.
    const runs = [];
    for (const w of [...new Set(widths.map(widthOf))].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (step && last && w - last[1] <= step) last[1] = w;
      else runs.push([w, w]);
    }
    findings.push({
      check: hit.check,
      kind: hit.kind,
      severity: worst.hit.severity,
      selector: hit.selector,
      ...(hit.selector2 ? { selector2: hit.selector2 } : {}),
      ...(hit.trigger ? { trigger: hit.trigger } : {}),
      text: hit.text ?? null,
      route: target.route,
      state: target.state,
      viewports: [...new Set(widths.map((v) => v.name))],
      widths: runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", "),
      measure: { value: worst.hit.value, unit: worst.hit.unit ?? "px", ...(worst.hit.measure ?? {}) },
      message: worst.hit.message,
      worst: { viewport: worst.viewport.name, width: worst.viewport.width, height: worst.viewport.height },
      image: null,
      _mark: { selector: worst.hit.selector, selector2: worst.hit.selector2 ?? null, scroll: worst.hit.scroll ?? "center", fold: worst.hit.fold ?? null, before: worst.hit.before ?? null },
      _target: target,
      _viewport: worst.viewport,
    });
  }
  const rank = (f) => SEVERITY_RANK[f.severity] ?? 0;
  return findings.sort((a, b) => rank(b) - rank(a) || a.check.localeCompare(b.check) || a.selector.localeCompare(b.selector));
}

/** One image per finding, at its worst viewport: the box outlined, the fold or the covering box marked. */
async function photograph(browser, { findings, open, outDir, warnings }) {
  // Every kind of finding gets its picture before any kind gets a second: the worst of each first.
  const kinds = new Map();
  for (const finding of findings) kinds.set(`${finding.check}/${finding.kind}`, [...(kinds.get(`${finding.check}/${finding.kind}`) ?? []), finding]);
  const queue = [];
  for (let round = 0; queue.length < MAX_IMAGES; round += 1) {
    const before = queue.length;
    for (const list of kinds.values()) if (list[round] && queue.length < MAX_IMAGES) queue.push(list[round]);
    if (queue.length === before) break;
  }
  if (findings.length > MAX_IMAGES)
    warnings.push(`images: only the first ${MAX_IMAGES} of ${findings.length} findings are photographed`);
  const byPage = new Map();
  for (const finding of queue) {
    const key = `${finding._target.id}|${finding._viewport.name}|${finding.check === "stable" ? finding.trigger : ""}`;
    byPage.set(key, [...(byPage.get(key) ?? []), finding]);
  }
  let index = 0;
  for (const group of byPage.values()) {
    const [{ _target: target, _viewport: viewport, check, trigger }] = group;
    let opened;
    try {
      opened = await openPage(browser, { ...open, viewport, target });
      if (check === "stable") {
        const { how, css } = parseTrigger(trigger);
        await opened.page.locator(css).first()[how === "hover" ? "hover" : "click"]({ timeout: 5_000 });
        await opened.page.waitForTimeout(150);
      }
      for (const finding of group) {
        index += 1;
        const name = `${String(index).padStart(2, "0")}-${safeName(finding.check)}-${safeName(finding.selector).slice(-40)}-${safeName(viewport.name)}.png`;
        const path = join(outDir, "images", name);
        try {
          const { clip, full, note } = (await measure(opened.page, inMark, finding._mark)).value;
          await opened.page.screenshot({ path, clip: clipOf(clip), fullPage: full, animations: "disabled" });
          finding.image = relative(outDir, path).split(sep).join("/");
          if (note) finding.image_note = note;
        } catch (error) {
          warnings.push(`no image for ${finding.check} ${finding.selector}: ${firstLine(error)}`);
        } finally {
          await measure(opened.page, inUnmark).catch(() => {});
        }
      }
    } catch (error) {
      warnings.push(`no images at ${viewport.name}: ${firstLine(error)}`);
    } finally {
      await opened?.context.close().catch(() => {});
    }
  }
  for (const finding of findings) {
    delete finding._mark;
    delete finding._target;
    delete finding._viewport;
  }
}

// ---------------------------------------------------------------- report

function renderReport(r) {
  const high = r.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high).length;
  const lines = [
    "# Geometry",
    "",
    `${r.ok ? "**PASS**" : r.blocked ? "**BLOCKED**" : "**FAIL**"} · ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} (${high} high), ${r.errors.length} error${r.errors.length === 1 ? "" : "s"} · checks ${r.checks.join(", ")} · ${r.viewports.length} viewport${r.viewports.length === 1 ? "" : "s"} (${r.viewports[0].width}–${r.viewports[r.viewports.length - 1].width} px wide) · ${r.seconds} s`,
    "",
    `\`${r.base_url}\` · ${r.targets.map((t) => `\`${t.state ?? t.route}\``).join(", ")}`,
    "",
  ];
  if (r.findings.length) {
    // The first MAX_ROWS of each kind are listed (worst first); the rest is in report.json (the worst `maxPerKind` of each kind).
    const seen = new Map();
    const shown = r.findings.map((f, i) => ({ f, n: i + 1 })).filter(({ f }) => {
      const key = `${f.check}/${f.kind}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return seen.get(key) <= MAX_ROWS;
    });
    lines.push("| # | Severity | Check | Where | Widths | Measure | Image |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const { f, n } of shown)
      lines.push(`| ${n} | ${f.severity} | ${f.check} | ${f.state ?? f.route} · \`${f.selector}\` | ${f.widths} | ${f.measure.value} ${f.measure.unit} | ${f.image ? `[${f.image}](${f.image})` : "—"} |`);
    const hidden = [...seen].filter(([, n]) => n > MAX_ROWS).map(([key, n]) => `${n - MAX_ROWS} more ${key}`);
    if (hidden.length) lines.push("", `Not listed here, see report.json: ${hidden.join(", ")}.`);
    lines.push("", "## Details", "");
    for (const { f, n } of shown)
      lines.push(`${n}. **${f.check}** (${f.kind}) \`${f.selector}\`${f.text ? ` «${f.text}»` : ""} — ${f.message}. Worst at ${f.worst.width} × ${f.worst.height}; found at ${f.widths}.${f.trigger ? ` Trigger \`${f.trigger}\`.` : ""}${f.image_note ? ` Picture: ${f.image_note}.` : ""}`);
    lines.push("");
  }
  const ranNote = Object.entries(r.coverage).filter(([, c]) => c.ran < c.of).map(([name, c]) => `${name} ran ${c.ran} of ${c.of} times`);
  if (ranNote.length) lines.push("## Coverage", "", ...ranNote.map((n) => `- ${n}`), "");
  if (r.truncated.length)
    lines.push(
      "## Cut short",
      "",
      ...r.truncated.map((t) => `- ${describeCut(t)} (${t.state ?? t.route}, ${t.viewports.length === 1 ? t.viewports[0] : `${t.viewports.length} viewports`}${t.cut === "targets" ? ", run is BLOCKED" : ""})`),
      "",
    );
  if (r.errors.length) lines.push("## Errors", "", ...r.errors.map((e) => `- ${[e.route, e.viewport, e.check].filter(Boolean).join(" · ")}${e.message ? `: ${e.message}` : ""}`), "");
  if (r.warnings.length) lines.push("## Notes", "", ...r.warnings.map((w) => `- ${w}`), "");
  if (r.ok) lines.push("No finding.", "");
  return lines.join("\n");
}

async function write({ baseUrl, outDir, checks, viewports, targets, findings, errors, warnings, coverage, truncated, loaded, seconds, opts }) {
  // Not measured is not clean: a page that did not load, a check that failed, or a page too big to walk to the end blocks a PASS.
  const blocked = errors.length > 0 || loaded === 0 || truncated.some((t) => t.cut === "targets");
  const result = {
    schema_version: GEOMETRY_SCHEMA,
    ok: !findings.length && !blocked,
    blocked,
    base_url: baseUrl,
    checks,
    viewports,
    targets: targets.map(({ route, state }) => ({ route, state })),
    options: { min_gap: opts.minGap, touch_max: opts.touchMax, tap_min: opts.tapMin, move_tol: opts.moveTol },
    findings,
    errors,
    warnings,
    truncated,
    coverage,
    seconds,
  };
  result.report = renderReport(result);
  await writeFile(join(outDir, "report.md"), result.report);
  await writeFile(join(outDir, "report.json"), `${JSON.stringify({ ...result, report: undefined }, null, 2)}\n`);
  result.outDir = outDir;
  return result;
}

/** Exit code of a geometry run: 0 clean, 1 findings, 2 something could not be measured. */
export const geometryExitCode = (result) => (result.blocked ? 2 : result.findings.length ? 1 : 0);
