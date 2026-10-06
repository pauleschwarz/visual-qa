// Baselines: calm screenshots per route × viewport × part, and a pixel diff between two such folders.
//
// Layout (one folder per route key):
//   <dir>/<route-key>/<viewport>.png              part "top"      first view, as a visitor sees it
//   <dir>/<route-key>/<viewport>.page.png         part "page"     whole document, only when it scrolls
//   <dir>/<route-key>/<viewport>.scroller-<n>.png part "scroller" every inner scroll area, whole (DOM order)
//   <dir>/baseline-manifest.json                  conditions, entries, load errors
// `top` keeps the historic `<route-key>/<viewport>.png` path, so `--baseline-dir` and the
// legacy flat `<viewport>.png` lookup keep working.

import { access, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  DEFAULT_BASELINE_LOCALE as DEFAULT_LOCALE,
  DEFAULT_BASELINE_TIMEZONE as DEFAULT_TIMEZONE,
  DEFAULT_PIXEL_THRESHOLD,
  DEFAULT_THRESHOLD_PCT,
  DEFAULT_VIEWPORTS,
  REFERENCE_PIXELS,
} from "./config.mjs";

export const MANIFEST_NAME = "baseline-manifest.json";
export const MANIFEST_SCHEMA = "vqa-baseline-capture-0.2";
const COMPARE_SCHEMA = "vqa-baseline-compare-0.1";

export function routeKeyFromTarget(target, baseUrl) {
  const raw = String(target ?? "").trim() || "/";
  let pathPart = raw;
  try {
    const resolved = baseUrl ? new URL(raw, baseUrl) : new URL(raw, "http://local/");
    pathPart = resolved.pathname || "/";
    if (resolved.search) pathPart += resolved.search;
  } catch {
    pathPart = raw.startsWith("/") ? raw : `/${raw}`;
  }
  const key = pathPart
    .replace(/^\//, "")
    .replace(/\/+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return key || "root";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve baseline PNG for a viewport, optionally scoped to a route key.
 * Prefer hierarchical path; fall back to flat legacy <viewport>.png.
 */
export async function resolveBaselinePath(
  baselineDir,
  viewportName,
  { routeKey = null } = {},
) {
  const root = resolve(baselineDir);
  const hierarchical =
    routeKey != null && String(routeKey).length
      ? join(root, String(routeKey), `${viewportName}.png`)
      : null;
  const flat = join(root, `${viewportName}.png`);

  if (hierarchical && (await exists(hierarchical))) {
    return {
      path: hierarchical,
      shape: "hierarchical",
      route_key: routeKey,
      viewport: viewportName,
      missing: false,
    };
  }
  if (await exists(flat)) {
    return {
      path: flat,
      shape: "legacy_flat",
      route_key: routeKey,
      viewport: viewportName,
      missing: false,
    };
  }
  return {
    path: hierarchical || flat,
    shape: hierarchical ? "hierarchical" : "legacy_flat",
    route_key: routeKey,
    viewport: viewportName,
    missing: true,
  };
}

export async function baselineMissing(
  baselineDir,
  viewportName,
  { routeKey = null } = {},
) {
  const resolved = await resolveBaselinePath(baselineDir, viewportName, {
    routeKey,
  });
  return resolved.missing;
}

export async function readBaselineBytes(path) {
  return readFile(path);
}

// ---------------------------------------------------------------- pixel compare (no browser)

const PAD_RGBA = [255, 0, 255, 255];

function padded(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  for (let i = 0; i < out.data.length; i += 4) out.data.set(PAD_RGBA, i);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/**
 * Compare two PNG buffers. Different sizes are padded to the larger one with a marker
 * colour so the added or lost area counts as difference and shows red in the diff image.
 * Returns { pixels, total, pct, sizeA, sizeB, sizeChanged, diffPng }; diffPng is null
 * when nothing differs or `diff: false`.
 */
export function compareImages(
  bufferA,
  bufferB,
  { diff = true, pixelThreshold = DEFAULT_PIXEL_THRESHOLD } = {},
) {
  const a = PNG.sync.read(bufferA);
  const b = PNG.sync.read(bufferB);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  const pa = padded(a, width, height);
  const pb = padded(b, width, height);
  const out = diff ? new PNG({ width, height }) : null;
  const pixels = pixelmatch(
    pa.data,
    pb.data,
    out ? out.data : null,
    width,
    height,
    { threshold: pixelThreshold, alpha: 0.3, diffColor: [255, 0, 0] },
  );
  const total = width * height;
  return {
    pixels,
    total,
    pct: (pixels / total) * 100,
    sizeA: [a.width, a.height],
    sizeB: [b.width, b.height],
    sizeChanged,
    diffPng: out && (pixels > 0 || sizeChanged) ? PNG.sync.write(out) : null,
  };
}

/**
 * The one decision "did this image change?": a size change always does; otherwise more
 * differing pixels than `thresholdPct` percent of the image — measured against at most one
 * reference screen, so a tall page does not tolerate more pixels than a short one.
 */
export function isChange(result, thresholdPct = DEFAULT_THRESHOLD_PCT) {
  return result.sizeChanged || result.pixels > toleratedPixels(result.total, thresholdPct);
}

/** How many differing pixels an image of `total` pixels tolerates — the one formula for the decision and the report. */
export const toleratedPixels = (total, thresholdPct) =>
  (thresholdPct / 100) * Math.min(total, REFERENCE_PIXELS);

/** A pixel count for people: whole numbers without decimals, else two places. */
export const formatPixels = (px) => String(+px.toFixed(2));

// ---------------------------------------------------------------- folder layout

const PART_FILE = /^(.+?)(?:\.(page|scroller-\d+))?\.png$/;
const OWN_FILES = [MANIFEST_NAME, "report.md", "report.json"];

export const partFileName = (viewport, part) =>
  part === "top" ? `${viewport}.png` : `${viewport}.${part}.png`;

/** All baseline images below a folder: Map "<route-key>/<viewport>/<part>" → entry. */
async function listImages(dir) {
  const found = new Map();
  let routes;
  try {
    routes = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const route of routes) {
    if (!route.isDirectory() || route.name === "diff") continue;
    for (const file of await readdir(join(dir, route.name))) {
      const match = PART_FILE.exec(file);
      if (!match) continue;
      const entry = {
        route_key: route.name,
        viewport: match[1],
        part: match[2] ?? "top",
        path: join(dir, route.name, file),
      };
      found.set(`${entry.route_key}/${entry.viewport}/${entry.part}`, entry);
    }
  }
  return found;
}

export async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, MANIFEST_NAME), "utf8"));
  } catch {
    return null;
  }
}

/**
 * A folder visual-qa may write into: missing, empty, or one a capture or compare wrote
 * before (it holds the manifest or a report). Anything else is someone's — a mistyped --out
 * must never delete or overwrite their files.
 */
async function assertOwnFolder(root) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return entries;
  }
  const ours = async () =>
    entries.some((e) => e.name === MANIFEST_NAME) ||
    (await readFile(join(root, "report.json"), "utf8").then(
      (text) => JSON.parse(text).schema_version === COMPARE_SCHEMA,
      () => false,
    ));
  if (entries.length && !(await ours()))
    throw new Error(
      `${root} is not empty and holds neither ${MANIFEST_NAME} nor a compare report.json — refusing to write into it; pick an empty or earlier baseline folder`,
    );
  return entries;
}

/** Remove what a capture or compare wrote before — images, diff/, manifest, reports — and nothing else. */
export async function cleanOwnFiles(dir) {
  const root = resolve(dir);
  const entries = await assertOwnFolder(root);
  await rm(join(root, "diff"), { recursive: true, force: true });
  for (const name of OWN_FILES) await rm(join(root, name), { force: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "diff") continue;
    const routeDir = join(root, entry.name);
    for (const file of await readdir(routeDir)) {
      if (PART_FILE.test(file)) await rm(join(routeDir, file), { force: true });
    }
    await rmdir(routeDir).catch(() => {});
  }
}

// ---------------------------------------------------------------- compare folders (no browser)

const routeLabel = (key, targets) => targets.get(key) ?? (key === "root" ? "/" : key);
const sizeText = (e) =>
  e.size_old && e.size_new
    ? e.size_old.join("×") === e.size_new.join("×")
      ? e.size_new.join("×")
      : `${e.size_old.join("×")} → ${e.size_new.join("×")}`
    : "";
const diffFileName = (e) => `${e.route_key}__${e.viewport}__${e.part}.png`;

/**
 * Compare two baseline folders. Writes <out>/diff/*.png for every differing image and
 * <out>/report.md + report.json. Never captures. `scope` limits which baseline images
 * must exist in the new folder ({ routeKeys, viewports } sets).
 */
export async function compareFolders(
  baseDir,
  newDir,
  {
    thresholdPct = DEFAULT_THRESHOLD_PCT,
    pixelThreshold = DEFAULT_PIXEL_THRESHOLD,
    outDir = newDir,
    scope = null,
  } = {},
) {
  const base = resolve(baseDir);
  const fresh = resolve(newDir);
  const out = resolve(outDir);
  if (base === fresh) throw new Error("baseline and new folder are the same folder");
  if (out === base) throw new Error("output folder must not be the baseline folder");
  // Default out = the new folder (its owner chose it); any other --out must be ours or empty.
  if (out !== fresh) await assertOwnFolder(out);
  const before = await listImages(base);
  const after = await listImages(fresh);
  if (!before.size) throw new Error(`no baseline images in ${base}`);
  const baseManifest = await readManifest(base);
  const newManifest = await readManifest(fresh);
  const targets = new Map();
  for (const m of [baseManifest, newManifest])
    for (const r of m?.routes ?? []) targets.set(r.key, r.target);

  await rm(join(out, "diff"), { recursive: true, force: true });
  await mkdir(join(out, "diff"), { recursive: true });

  const inScope = (e) =>
    !scope ||
    ((!scope.routeKeys || scope.routeKeys.has(e.route_key)) &&
      (!scope.viewports || scope.viewports.has(e.viewport)));
  const changed = [];
  const same = [];
  const added = [];
  const missing = [];
  for (const [key, entry] of after) {
    const old = before.get(key);
    if (!old) {
      added.push({ ...entry, route: routeLabel(entry.route_key, targets) });
      continue;
    }
    const result = compareImages(await readFile(old.path), await readFile(entry.path), { pixelThreshold });
    const row = {
      route: routeLabel(entry.route_key, targets),
      route_key: entry.route_key,
      viewport: entry.viewport,
      part: entry.part,
      pct: result.pct,
      pixels: result.pixels,
      size_old: result.sizeA,
      size_new: result.sizeB,
      size_changed: result.sizeChanged,
      old_path: old.path,
      new_path: entry.path,
    };
    if (isChange(result, thresholdPct)) {
      row.diff_path = join(out, "diff", diffFileName(row));
      await writeFile(row.diff_path, result.diffPng);
      changed.push(row);
    } else same.push(row);
  }
  for (const [key, entry] of before) {
    if (!after.has(key) && inScope(entry))
      missing.push({ ...entry, route: routeLabel(entry.route_key, targets) });
  }
  const errors = newManifest?.errors ?? [];
  const skipped = newManifest?.skipped ?? [];
  const below = same.filter((r) => r.pixels > 0);
  const result = {
    schema_version: COMPARE_SCHEMA,
    baseline: base,
    current: fresh,
    threshold_pct: thresholdPct,
    pixel_threshold: pixelThreshold,
    ok: !changed.length && !missing.length && !errors.length,
    compared: changed.length + same.length,
    changed,
    same: same.length,
    tolerated: { images: below.length, max_pixels: Math.max(0, ...below.map((r) => r.pixels)) },
    added,
    missing,
    errors,
    skipped,
    conditions: { baseline: baseManifest?.conditions ?? null, current: newManifest?.conditions ?? null },
  };
  result.report = renderReport(result, out);
  await writeFile(join(out, "report.md"), result.report);
  await writeFile(
    join(out, "report.json"),
    `${JSON.stringify({ ...result, report: undefined }, null, 2)}\n`,
  );
  return result;
}

function renderReport(r, out) {
  const rel = (p) => relative(out, p).split(sep).join("/");
  const lines = [
    "# Baseline compare",
    "",
    `${r.ok ? "**PASS**" : "**FAIL**"} · ${r.compared} compared, ${r.changed.length} changed, ${r.same} same, ${r.added.length} new, ${r.missing.length} missing, ${r.errors.length} load errors`,
    "",
    `Baseline \`${r.baseline}\` · Current \`${r.current}\` · Threshold ${r.threshold_pct} % of an image's pixels, counted on at most one ${REFERENCE_PIXELS.toLocaleString("en-US")}-pixel screen (so never more than ${formatPixels(toleratedPixels(REFERENCE_PIXELS, r.threshold_pct))} px; a smaller image tolerates fewer), colour distance ${r.pixel_threshold} (a size change always counts)`,
    "",
  ];
  if (r.tolerated.images)
    lines.push(
      `Below the threshold, not counted: ${r.tolerated.images} image${r.tolerated.images === 1 ? " differs" : "s differ"} by at most ${r.tolerated.max_pixels} px`,
      "",
    );
  const cond = r.conditions.current ?? r.conditions.baseline;
  if (cond)
    lines.push(
      `Conditions: clock ${cond.clock ?? "real time"} · locale ${cond.locale} · timezone ${cond.timezone}`,
      "",
    );
  if (r.changed.length) {
    lines.push(
      "## Changed",
      "",
      "| Route | Viewport | Part | Changed | Size | Diff |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    const order = [...r.changed].sort(
      (a, b) =>
        a.route.localeCompare(b.route) ||
        a.viewport.localeCompare(b.viewport) ||
        a.part.localeCompare(b.part, undefined, { numeric: true }),
    );
    for (const e of order)
      lines.push(
        `| ${e.route} | ${e.viewport} | ${e.part} | ${e.pixels} px (${e.pct.toFixed(4)} %)${e.size_changed ? " · size changed" : ""} | ${sizeText(e)} | ${rel(e.diff_path)} |`,
      );
    lines.push("");
  }
  const list = (title, items, text) => {
    if (items.length) lines.push(`## ${title}`, "", ...items.map(text), "");
  };
  list(
    "Missing (baseline has it, current does not)",
    r.missing,
    (e) => `- ${e.route} · ${e.viewport} · ${e.part}`,
  );
  list(
    "New (no baseline, not an error)",
    r.added,
    (e) => `- ${e.route} · ${e.viewport} · ${e.part}`,
  );
  list(
    "Load errors",
    r.errors,
    (e) => `- ${e.route ?? "/"} · ${e.viewport ?? "-"}: ${e.message}`,
  );
  list(
    "Not captured (a part that cannot be photographed; not an error)",
    r.skipped ?? [],
    (e) => `- ${e.route ?? "/"} · ${e.viewport} · ${e.part}: ${e.reason}`,
  );
  if (r.ok) lines.push("No difference above the threshold.", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------- capture (browser)

/** Motion off in every image (Playwright hides the caret by default); the context also asks for reduced motion. */
const SHOT = { animations: "disabled" };
/** A scroller that gives no picture in this time is skipped (named in the report), not a load error. */
const SCROLLER_SHOT_MS = 5_000;
const QUIET_POLL_MS = 100;
const QUIET_EQUAL_PROBES = 3;
const QUIET_MAX_PROBES = 50;

/**
 * In-page, the one definition of an inner scroller: an element you can see (checkVisibility:
 * no display:none or content-visibility:hidden up the tree, computed visibility visible; and a
 * box with a size) that scrolls vertically (not a form field), in DOM order,
 * with more than `slack` px still to scroll. A menu hidden by visibility, display or content-visibility is none —
 * it cannot be photographed. <body> counts only when <html> is not `visible` in both axes —
 * otherwise the viewport takes <body>'s overflow, the page scrolls and <body> would only double the page part; the page's own
 * scrolling is the page part. Capture, the settle check and the layout check all ask this;
 * a page function reaches it through inPage().
 */
function innerScrollers(slack) {
  // The viewport takes <body>'s overflow only while <html> is visible in both axes (CSS Overflow 3).
  const root = getComputedStyle(document.documentElement);
  const bodyOwnsScroll = root.overflowX !== "visible" || root.overflowY !== "visible";
  return [...document.querySelectorAll("body, body *")].filter((el) => {
    if (el === document.body && !bodyOwnsScroll) return false;
    if (["TEXTAREA", "SELECT", "INPUT"].includes(el.tagName)) return false;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect(); // display:none or an empty box: zero
    return (
      /(auto|scroll)/.test(style.overflowY) &&
      el.checkVisibility({ visibilityProperty: true }) &&
      box.width > 0 &&
      box.height > 0 &&
      el.scrollHeight > el.clientHeight + slack
    );
  });
}

/** page.evaluate for a function that may call innerScrollers(slack). Built as text, so a page CSP cannot block it. */
export function inPage(page, fn) {
  return page.evaluate(`(() => { ${innerScrollers}; return (${fn})(); })()`);
}

/** In-page: every inner scroller worth a picture gets data-vqa-scroller="<n>". Returns the count. */
export function markScrollers() {
  let count = 0;
  for (const el of innerScrollers(1)) {
    if (el.clientWidth < 32 || el.clientHeight < 32) continue;
    count += 1;
    el.setAttribute("data-vqa-scroller", String(count));
  }
  return count;
}

/**
 * In-page: show scroller <n> whole. It and its ancestors grow to content height; fixed
 * ancestors turn absolute and lose their bottom pin so the grown box is reachable; fixed/sticky chrome elsewhere
 * (header, rail, composer, cookie banner) is hidden so it cannot cover content.
 * Original inline styles are kept for restoreStretch().
 */
export function stretchScroller(n) {
  const el = document.querySelector(`[data-vqa-scroller="${n}"]`);
  if (!el) return; // the page removed it; the capture names it as not captured
  const saved = new Map();
  // Written as attribute text, not through node.style: removing a style set via CSSOM leaves an empty style="".
  const addStyle = (node, css) => {
    if (!saved.has(node)) saved.set(node, node.getAttribute("style"));
    node.setAttribute("style", `${node.getAttribute("style") ?? ""};${css}`);
  };
  for (const node of document.querySelectorAll("body *")) {
    const position = getComputedStyle(node).position;
    if (position !== "fixed" && position !== "sticky") continue;
    if (node.contains(el)) continue;
    if (position === "sticky" && el.contains(node)) continue;
    addStyle(node, "visibility:hidden!important");
  }
  // Up to <html>: with html{overflow:hidden} and a scrolling <body>, html would cut the grown box off.
  for (let node = el; node; node = node.parentElement) {
    const position = getComputedStyle(node).position;
    // top + bottom together would pin the height of an absolute box.
    const pin =
      position === "fixed"
        ? "position:absolute!important;bottom:auto!important;"
        : position === "absolute"
          ? "bottom:auto!important;"
          : "";
    addStyle(node, `${pin}height:auto!important;max-height:none!important;overflow:visible!important`);
  }
  window.__vqaSaved = [...saved];
}

export function restoreStretch() {
  for (const [node, style] of window.__vqaSaved ?? []) {
    if (style === null) node.removeAttribute("style");
    else node.setAttribute("style", style);
  }
  window.__vqaSaved = [];
}

function toTop() {
  window.scrollTo(0, 0);
  for (const el of document.querySelectorAll("body, body *")) if (el.scrollTop) el.scrollTop = 0;
}

function layoutSignature() {
  const scrollers = innerScrollers(1).map((el) => [el.scrollHeight, el.scrollTop]);
  const pending = [...document.images].filter((img) => !img.complete).length;
  return JSON.stringify([window.scrollY, document.documentElement.scrollHeight, scrollers, pending]);
}

/** Same calm for capture and compare: network idle, fonts ready, layout unchanged for 300 ms. */
async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(toTop);
  let last = null;
  let equal = 0;
  for (let i = 0; i < QUIET_MAX_PROBES && equal < QUIET_EQUAL_PROBES; i += 1) {
    await page.waitForTimeout(QUIET_POLL_MS);
    const now = await inPage(page, layoutSignature);
    equal = now === last ? equal + 1 : 0;
    last = now;
  }
  return equal >= QUIET_EQUAL_PROBES;
}

const firstLine = (error) => String(error?.message ?? error).split("\n")[0];

const SAFE_VIEWPORT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function checkViewportNames(viewports) {
  for (const { name } of viewports) {
    if (!SAFE_VIEWPORT.test(name))
      throw new Error(
        `baseline viewport name "${name}" must be letters, digits, "_" or "-" (it becomes a file name)`,
      );
  }
}

/** Throws if nothing answers at baseUrl, before anything on disk is touched. */
export async function assertReachable(baseUrl) {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
    await res.arrayBuffer().catch(() => {});
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    throw new Error(`${baseUrl} does not answer (${firstLine(error)}) — is the server running on that port?`);
  }
}

async function captureRoute(page, { url, target, routeKey, viewport, dir, navigationTimeoutMs }) {
  const entries = [];
  const errors = [];
  const where = { route: target, route_key: routeKey, viewport: viewport.name };
  let response;
  try {
    response = await page.goto(url, { waitUntil: "load", timeout: navigationTimeoutMs });
    if (response && response.status() >= 400) {
      errors.push({ ...where, message: `HTTP ${response.status()}` });
      return { entries, errors };
    }
    if (!(await settle(page)))
      errors.push({ ...where, message: "page never settled (layout keeps changing)" });
  } catch (error) {
    errors.push({ ...where, message: `load failed: ${firstLine(error)}` });
    return { entries, errors };
  }
  // Real sites hold scrollers that cannot be photographed whole: content outside the flow collapses the grown box,
  // a script hides or removes it. Such a part is skipped and named, so one odd box never fails the capture.
  const skipped = [];
  /** One picture and its manifest entry; with `skip`, a failure names the part as not captured instead of a load error. */
  const shoot = async (part, take, skip = null) => {
    const file = join(dir, partFileName(viewport.name, part));
    try {
      await take(file);
      entries.push({ ...where, part, url, file: relative(resolve(dir, ".."), file).split(sep).join("/") });
    } catch (error) {
      if (skip) skipped.push({ ...where, part, reason: `${skip} (${firstLine(error)})` });
      else errors.push({ ...where, part, message: `${part}: ${firstLine(error)}` });
    }
  };
  await shoot("top", (path) => page.screenshot({ path, ...SHOT }));
  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  if (docHeight > viewport.height + 1)
    await shoot("page", (path) => page.screenshot({ path, fullPage: true, ...SHOT }));
  const scrollers = await inPage(page, markScrollers);
  const boxOf = (k) => {
    const el = document.querySelector(`[data-vqa-scroller="${k}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, content: el.scrollHeight };
  };
  for (let n = 1; n <= scrollers; n += 1) {
    const part = `scroller-${n}`;
    try {
      const before = await page.evaluate(boxOf, n);
      if (before) {
        await page.evaluate(stretchScroller, n);
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
      }
      const grown = before && (await page.evaluate(boxOf, n));
      // A picture shorter than nine tenths of the content would be a strip, not the scroller (a reflow without the
      // scrollbar may cost a line or two, never a tenth).
      const reason = !grown
        ? "removed by the page before its picture"
        : !(grown.width > 0 && grown.height > 0)
          ? "has no box when grown (hidden, or all its content sits outside the flow)"
          : grown.height < 0.9 * before.content
            ? `shows ${Math.round(grown.height)} of ${before.content} px when grown (its content does not grow with it)`
            : null;
      if (reason) skipped.push({ ...where, part, reason });
      else
        await shoot(
          part,
          (path) => page.locator(`[data-vqa-scroller="${n}"]`).screenshot({ path, timeout: SCROLLER_SHOT_MS, ...SHOT }),
          `no picture within ${SCROLLER_SHOT_MS / 1000} s`,
        );
    } catch (error) {
      errors.push({ ...where, part, message: `${part}: ${firstLine(error)}` });
    } finally {
      await page.evaluate(restoreStretch).catch(() => {});
    }
  }
  return { entries, errors, skipped };
}

/**
 * Capture every target × viewport from a running URL (the app under test is never started
 * here). Replaces what an earlier capture left in outDir. Returns { outDir, manifestPath,
 * entries, errors }; load problems are recorded in `errors`, not thrown.
 */
export async function captureBaselines({
  baseUrl,
  outDir,
  targets = ["/"],
  viewports = DEFAULT_VIEWPORTS,
  clock = null,
  locale = DEFAULT_LOCALE,
  timezone = DEFAULT_TIMEZONE,
  navigationTimeoutMs = 15_000,
} = {}) {
  if (!baseUrl) throw new Error("baseline capture requires --url / baseUrl");
  checkViewportNames(viewports);
  const clockDate = clock ? new Date(clock) : null;
  if (clockDate && Number.isNaN(clockDate.getTime()))
    throw new Error(`clock "${clock}" is not an ISO date-time`);
  const routes = new Map();
  for (const target of targets) {
    const key = routeKeyFromTarget(target, baseUrl);
    if (key === "diff")
      throw new Error(`route "${target}" would be stored in "diff/", the folder of the diff images — it cannot be baselined`);
    if (routes.has(key) && routes.get(key) !== target)
      throw new Error(
        `routes "${routes.get(key)}" and "${target}" map to the same folder "${key}"`,
      );
    routes.set(key, target);
  }
  await assertReachable(baseUrl);
  const root = resolve(outDir);
  await cleanOwnFiles(root);
  await mkdir(root, { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const entries = [];
  const errors = [];
  const skipped = [];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        reducedMotion: "reduce",
        locale,
        timezoneId: timezone,
        serviceWorkers: "block",
      });
      try {
        for (const [routeKey, target] of routes) {
          const page = await context.newPage();
          if (clockDate) await page.clock.setFixedTime(clockDate);
          const dir = join(root, routeKey);
          await mkdir(dir, { recursive: true });
          const result = await captureRoute(page, {
            url: new URL(target, baseUrl).toString(),
            target,
            routeKey,
            viewport,
            dir,
            navigationTimeoutMs,
          });
          entries.push(...result.entries);
          errors.push(...result.errors);
          skipped.push(...(result.skipped ?? []));
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  const manifestPath = join(root, MANIFEST_NAME);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schema_version: MANIFEST_SCHEMA,
        base_url: baseUrl,
        captured_at: new Date().toISOString(),
        conditions: { clock: clock ?? null, locale, timezone, reduced_motion: true },
        routes: [...routes].map(([key, target]) => ({ key, target })),
        viewports,
        entries,
        errors,
        skipped,
      },
      null,
      2,
    )}\n`,
  );
  return { outDir: root, manifestPath, entries, errors, skipped };
}

/**
 * Capture the current state of a URL into outDir and compare it with a baseline folder,
 * under the baseline's own conditions unless overridden. Routes and viewports default to
 * what the baseline holds.
 */
export async function compareToBaseline({
  baseUrl,
  baselineDir,
  outDir,
  targets = null,
  viewports = null,
  clock,
  locale,
  timezone,
  thresholdPct = DEFAULT_THRESHOLD_PCT,
  pixelThreshold = DEFAULT_PIXEL_THRESHOLD,
  navigationTimeoutMs,
} = {}) {
  const base = resolve(baselineDir);
  if (resolve(outDir) === base)
    throw new Error("output folder must not be the baseline folder (it would be emptied)");
  const manifest = await readManifest(base);
  const cond = manifest?.conditions ?? {};
  // A baseline that recorded no conditions at all (an old capture) has nothing to contradict.
  const pick = (given, recorded, label) => {
    if (given != null && manifest?.conditions && given !== (recorded ?? null))
      throw new Error(
        `${label} "${given}" differs from the baseline's "${recorded ?? "real time"}" — compare under the same conditions or capture a new baseline`,
      );
    return given ?? recorded;
  };
  const useClock = pick(clock, cond.clock, "clock") ?? null;
  const useLocale = pick(locale, cond.locale, "locale") ?? DEFAULT_LOCALE;
  const useZone = pick(timezone, cond.timezone, "timezone") ?? DEFAULT_TIMEZONE;
  // Routes: asked for, else what the baseline recorded (an old capture only lists them per image).
  const recorded = manifest?.routes?.map((r) => r.target) ?? [
    ...new Set((manifest?.entries ?? []).map((e) => e.target).filter(Boolean)),
  ];
  const useTargets = targets?.length ? targets : recorded.length ? recorded : ["/"];
  const useViewports = viewports?.length ? viewports : manifest?.viewports ?? DEFAULT_VIEWPORTS;
  const capture = await captureBaselines({
    baseUrl,
    outDir,
    targets: useTargets,
    viewports: useViewports,
    clock: useClock,
    locale: useLocale,
    timezone: useZone,
    navigationTimeoutMs,
  });
  const scope = {
    routeKeys: new Set(useTargets.map((t) => routeKeyFromTarget(t, baseUrl))),
    viewports: new Set(useViewports.map((v) => v.name)),
  };
  const result = await compareFolders(base, capture.outDir, { thresholdPct, pixelThreshold, scope });
  return { ...result, capture };
}
