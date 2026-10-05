// Baselines in a real browser against fixture/baseline-app.mjs: parts, calm, stability,
// sensitivity, load errors, conditions, CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { startBaselineApp } from "../fixture/baseline-app.mjs";
import {
  captureBaselines,
  compareFolders,
  compareToBaseline,
  markScrollers,
  restoreStretch,
  stretchScroller,
} from "../src/baseline.mjs";
import { runLayoutChecks } from "../src/checks.mjs";
import { explore } from "../src/explore.mjs";

const CLI = new URL("../bin/visual-qa.mjs", import.meta.url).pathname;
const CLOCK = "2026-10-05T10:00:00+02:00";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

const app = await startBaselineApp();
test.after(() => app.close());

const tmp = (name) => mkdtemp(join(tmpdir(), `vqa-e2e-${name}-`));
const png = async (path) => PNG.sync.read(await readFile(path));
const names = async (dir, route) => (await readdir(join(dir, route))).sort();

async function capture(targets, extra = {}) {
  const outDir = await tmp("cap");
  const result = await captureBaselines({
    baseUrl: app.url,
    outDir,
    targets,
    viewports: VIEWPORTS,
    clock: CLOCK,
    ...extra,
  });
  return { ...result, dir: outDir };
}

const changedKeys = (r) =>
  r.changed.map((e) => `${e.route_key}/${e.viewport}/${e.part}`).sort();

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("parts: top always, page only when the document scrolls, one image per real inner scroller", async () => {
  app.setVariant("");
  const { dir, errors } = await capture(["/", "/long", "/short", "/widgets"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(await names(dir, "root"), [
    "desktop.png",
    "desktop.scroller-1.png",
    "desktop.scroller-2.png",
    "mobile.png",
    "mobile.scroller-1.png",
  ], "app shell: no page part (document does not scroll); mobile hides the thread panel");
  assert.deepEqual(await names(dir, "long"), [
    "desktop.page.png",
    "desktop.png",
    "mobile.page.png",
    "mobile.png",
  ]);
  assert.deepEqual(await names(dir, "short"), ["desktop.png", "mobile.png"], "no scroll, no scroller");
  assert.deepEqual(
    await names(dir, "widgets"),
    ["desktop.png", "desktop.scroller-1.png", "mobile.png", "mobile.scroller-1.png"],
    "textarea and a 20 px strip are not parts; the real scroller is",
  );
  const top = await png(join(dir, "root", "desktop.png"));
  assert.deepEqual([top.width, top.height], [1280, 800]);
  const long = await png(join(dir, "long", "desktop.page.png"));
  assert.ok(long.height > 3000, `whole page, not just the window (${long.height})`);
  // Whole scroller, even inside a fixed panel taller than the window.
  const thread = await png(join(dir, "root", "desktop.scroller-2.png"));
  assert.ok(thread.height > 1200, `fixed thread panel shown whole (${thread.height})`);
  const feed = await png(join(dir, "root", "desktop.scroller-1.png"));
  assert.ok(feed.height > 1700, `feed shown whole (${feed.height})`);
  // Chrome that is not part of the scroller stays out of its picture.
  const header = [0x11, 0x22, 0x33];
  const at = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  assert.notDeepEqual(at(feed, 100, 5), header, "fixed header hidden in scroller image");
  assert.notDeepEqual(at(thread, 100, thread.height - 10), [0xdd, 0xdd, 0xdd], "fixed composer hidden");
  // A sticky header inside the scroller is content and stays; the scroller shows from its top.
  const strip = await png(join(dir, "widgets", "desktop.scroller-1.png"));
  const yellow = Array.from({ length: 24 }, (_, y) => at(strip, 150, y)).some((c) => c[0] === 255 && c[1] === 255 && c[2] === 0);
  assert.ok(yellow, "sticky element inside the scroller still visible");
  const manifest = JSON.parse(await readFile(join(dir, "baseline-manifest.json"), "utf8"));
  assert.equal(manifest.conditions.clock, CLOCK);
  assert.equal(manifest.conditions.locale, "en-US");
  assert.equal(manifest.conditions.timezone, "UTC");
  assert.equal(manifest.entries.length, 5 + 4 + 2 + 4);
});

test("stretching and restoring leaves the page exactly as it was", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(app.url);
    const before = await page.evaluate(() => document.documentElement.outerHTML);
    assert.equal(await page.evaluate(markScrollers), 2);
    await page.evaluate(stretchScroller, 2);
    const during = await page.evaluate(() => ({
      composer: getComputedStyle(document.querySelector(".composer")).visibility,
      header: getComputedStyle(document.querySelector(".top")).visibility,
      thread: getComputedStyle(document.querySelector(".thread")).position,
      threadOverflow: getComputedStyle(document.querySelector(".thread")).overflowY,
      cookie: getComputedStyle(document.querySelector(".cookie")).visibility,
    }));
    assert.deepEqual(during, {
      composer: "hidden",
      header: "hidden",
      thread: "absolute",
      threadOverflow: "visible",
      cookie: "hidden",
    });
    await page.evaluate(restoreStretch);
    assert.equal(
      (await page.evaluate(() => document.documentElement.outerHTML)).replace(/ data-vqa-scroller="\d+"/g, ""),
      before,
      "markup identical after restore (apart from the scroller marks)",
    );
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".thread")).position), "fixed");
  } finally {
    await browser.close();
  }
});

test("stability: the same state captured three times differs by 0 pixels", async () => {
  app.setVariant("");
  const targets = ["/", "/long", "/late", "/widgets", "/motion"];
  const first = await capture(targets);
  for (let run = 2; run <= 3; run += 1) {
    const next = await capture(targets);
    const r = await compareFolders(first.dir, next.dir, { thresholdPct: 0 });
    assert.deepEqual(r.changed.map((e) => `${e.route_key}/${e.viewport}/${e.part} ${e.pixels}px`), [], `run ${run}`);
    assert.equal(r.ok, true);
    assert.equal(r.compared, 5 + 4 + 2 + 4 + 2);
  }
});

test("reduced motion is requested, and a never-ending animation does not move the picture", async () => {
  const { dir } = await capture(["/motion"], { viewports: [VIEWPORTS[0]] });
  const top = await png(join(dir, "motion", "desktop.png"));
  assert.deepEqual([...top.data.slice((10 * top.width + 10) * 4, (10 * top.width + 10) * 4 + 3)], [0x00, 0xcc, 0x00]);
});

test("a failure inside one part, or a page that never settles, is recorded — the run goes on", async () => {
  const { dir, errors, entries } = await capture(["/vanishing", "/restless", "/short"], { viewports: [VIEWPORTS[0]] });
  assert.deepEqual(
    errors.map((e) => `${e.route}${e.part ? ` ${e.part}` : ""}: ${e.message}`).sort(),
    [
      "/restless: page never settled (layout keeps changing)",
      "/vanishing scroller-1: scroller-1: page.evaluate: Error: the scroller disappeared before it could be captured",
    ],
  );
  const taken = entries.map((e) => `${e.route_key}/${e.part}`);
  for (const k of ["restless/top", "short/top", "vanishing/top"]) assert.ok(taken.includes(k), `${k} still taken`);
  assert.deepEqual(await names(dir, "vanishing"), ["desktop.png"]);
});

test("calm conditions matter: without the fixed clock the same state differs", async () => {
  const a = await capture(["/long"], { clock: null });
  const b = await capture(["/long"], { clock: null });
  const r = await compareFolders(a.dir, b.dir, { thresholdPct: 0 });
  assert.ok(r.changed.length > 0, "the page prints the time; unfixed, two captures cannot match");
});

test("fonts.ready is awaited: late layout settles before the shot", async () => {
  const { dir } = await capture(["/late"]);
  const top = await png(join(dir, "late", "desktop.png"));
  const probe = (top.width * 200 + 50) * 4;
  assert.deepEqual([...top.data.slice(probe, probe + 3)], [0x00, 0xaa, 0x66], "box already grown and green");
});

test("settle waits for what is still arriving: fetched content and a late layout change", async () => {
  const { dir } = await capture(["/fetching", "/timer"], { viewports: [VIEWPORTS[0]] });
  for (const route of ["fetching", "timer"]) {
    const top = await png(join(dir, route, "desktop.png"));
    const probe = (top.width * 200 + 50) * 4;
    assert.deepEqual([...top.data.slice(probe, probe + 3)], [0x00, 0xaa, 0x66], `${route}: box already grown and green`);
  }
});

test("locale and timezone are applied and recorded: they change what a date-printing page shows", async () => {
  const one = { viewports: [VIEWPORTS[0]] };
  const same = async (a, b) =>
    (await compareFolders(a.dir, b.dir, { thresholdPct: 0 })).changed.length === 0;
  const base = await capture(["/long"], one);
  assert.equal(await same(base, await capture(["/long"], one)), true, "same conditions, same picture");
  assert.equal(await same(base, await capture(["/long"], { ...one, locale: "de-CH" })), false, "locale");
  assert.equal(await same(base, await capture(["/long"], { ...one, timezone: "Europe/Zurich" })), false, "timezone");
  const manifest = JSON.parse(await readFile(join(base.dir, "baseline-manifest.json"), "utf8"));
  assert.deepEqual(manifest.viewports, [VIEWPORTS[0]]);
});

test("a small change is found at exactly its route, viewport and part; the diff image marks it", async () => {
  app.setVariant("");
  const base = await capture(["/", "/long", "/short", "/widgets"]);
  app.setVariant("b");
  const next = await capture(["/", "/long", "/short", "/widgets"]);
  const r = await compareFolders(base.dir, next.dir);
  assert.deepEqual(changedKeys(r), ["root/desktop/scroller-1", "root/mobile/scroller-1"],
    "a row below the fold of the feed: not in `top`, only in the whole scroller");
  assert.equal(r.ok, false);
  const diff = await png(r.changed.find((e) => e.viewport === "desktop").diff_path);
  const red = (x, y) => [...diff.data.slice((y * diff.width + x) * 4, (y * diff.width + x) * 4 + 3)];
  const rowTop = 34 * 43.5;
  let redFound = 0;
  for (let y = 0; y < diff.height; y += 1)
    for (let x = 0; x < diff.width; x += 4) if (red(x, y)[0] === 255 && red(x, y)[1] === 0) redFound += 1;
  assert.ok(redFound > 1000, `red pixels (${redFound})`);
  assert.deepEqual(red(400, Math.round(rowTop + 20)), [255, 0, 0], "red at the changed row");
  assert.notDeepEqual(red(400, 200), [255, 0, 0], "no red elsewhere");

  app.setVariant("header");
  const header = await capture(["/", "/long", "/short", "/widgets"]);
  const rh = await compareFolders(base.dir, header.dir);
  assert.deepEqual(changedKeys(rh), ["root/desktop/top", "root/mobile/top"], "fixed header: first view only");

  app.setVariant("more");
  const more = await capture(["/", "/long", "/short", "/widgets"]);
  const rm = await compareFolders(base.dir, more.dir);
  assert.deepEqual(changedKeys(rm), ["root/desktop/scroller-1", "root/mobile/scroller-1"]);
  assert.ok(rm.changed.every((e) => e.size_changed && e.size_old[1] < e.size_new[1]));
  assert.match(rm.report, /→/);
  app.setVariant("");
});

test("load errors are findings, not crashes; other routes still captured", async () => {
  app.setVariant("");
  const { dir, errors, entries } = await capture(["/", "/boom", "/drop", "/nope", "/short"]);
  const text = errors.map((e) => `${e.route} ${e.viewport}: ${e.message.split(" at ")[0]}`).sort();
  assert.deepEqual(text, [
    "/boom desktop: HTTP 500",
    "/boom mobile: HTTP 500",
    "/drop desktop: load failed: page.goto: net::ERR_EMPTY_RESPONSE",
    "/drop mobile: load failed: page.goto: net::ERR_EMPTY_RESPONSE",
    "/nope desktop: HTTP 404",
    "/nope mobile: HTTP 404",
  ]);
  for (const route of ["boom", "drop", "nope"]) assert.deepEqual(await names(dir, route), [], `${route}: no image`);
  assert.ok(entries.some((e) => e.route_key === "short"));
  const r = await compareFolders(dir, (await capture(["/", "/short"])).dir);
  assert.equal(r.ok, true, "errors belong to the new folder only");
  const back = await compareFolders((await capture(["/", "/short"])).dir, dir);
  assert.equal(back.ok, false);
  assert.equal(back.errors.length, 6);
  assert.match(back.report, /## Load errors[\s\S]*\/boom · desktop: HTTP 500/);
});

test("compare: new is no error, missing is, scope and conditions are kept", async () => {
  app.setVariant("");
  const base = await capture(["/", "/about-us"]);

  // Same state, same conditions inherited from the baseline: nothing found.
  const same = await compareToBaseline({ baseUrl: app.url, baselineDir: base.dir, outDir: await tmp("c1") });
  assert.equal(same.ok, true, same.report);
  assert.equal(same.compared, 5 + 2);

  // A route the baseline lacks is "new".
  const added = await compareToBaseline({
    baseUrl: app.url, baselineDir: base.dir, outDir: await tmp("c2"), targets: ["/", "/about-us", "/short"],
  });
  assert.equal(added.ok, true);
  assert.deepEqual(added.added.map((e) => e.route_key), ["short", "short"]);
  assert.match(added.report, /## New/);

  // A subset only has to match its own scope.
  const subset = await compareToBaseline({
    baseUrl: app.url, baselineDir: base.dir, outDir: await tmp("c3"), targets: ["/about-us"], viewports: [VIEWPORTS[1]],
  });
  assert.equal(subset.ok, true);
  assert.equal(subset.compared, 1);

  // A route that disappears: error line plus missing images.
  app.setVariant("gone");
  const gone = await compareToBaseline({ baseUrl: app.url, baselineDir: base.dir, outDir: await tmp("c4") });
  app.setVariant("");
  assert.equal(gone.ok, false);
  assert.deepEqual(gone.errors.map((e) => `${e.route}: ${e.message}`), ["/about-us: HTTP 404", "/about-us: HTTP 404"]);
  assert.deepEqual(gone.missing.map((e) => `${e.route} ${e.viewport}`).sort(), ["/about-us desktop", "/about-us mobile"]);

  // Other conditions would make every difference meaningless.
  await assert.rejects(
    compareToBaseline({ baseUrl: app.url, baselineDir: base.dir, outDir: await tmp("c5"), clock: "2027-01-01T00:00:00Z" }),
    /clock .* differs from the baseline's/,
  );
  await assert.rejects(
    compareToBaseline({ baseUrl: app.url, baselineDir: base.dir, outDir: await tmp("c6"), locale: "de-CH" }),
    /locale "de-CH" differs/,
  );
  await assert.rejects(
    compareToBaseline({ baseUrl: app.url, baselineDir: base.dir, outDir: base.dir }),
    /must not be the baseline folder/,
  );
});

test("capture replaces an earlier capture; a different route set leaves no old image behind", async () => {
  const out = await tmp("replace");
  await captureBaselines({ baseUrl: app.url, outDir: out, targets: ["/", "/short"], viewports: [VIEWPORTS[0]], clock: CLOCK });
  assert.ok((await readdir(out)).includes("short"));
  await captureBaselines({ baseUrl: app.url, outDir: out, targets: ["/about-us"], viewports: [VIEWPORTS[0]], clock: CLOCK });
  assert.deepEqual((await readdir(out)).sort(), ["about-us", "baseline-manifest.json"]);
});

test("CLI: capture, compare, change found, alias, load errors", async () => {
  app.setVariant("");
  const base = await tmp("cli-base");
  const flags = ["--url", app.url, "--route", "/", "--route", "/about-us", "--viewport", "desktop=1280x800", "--clock", CLOCK];
  const capture1 = await cli("baseline", "capture", ...flags, "--out", base);
  assert.equal(capture1.status, 0, capture1.stderr);
  assert.match(capture1.stdout, /baseline capture: 4 images, 0 load errors/);

  const out = await tmp("cli-out");
  const same = await cli("baseline", "compare", "--url", app.url, "--baseline", base, "--out", out);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /PASS/);

  app.setVariant("b");
  const changed = await cli("baseline", "compare", "--url", app.url, "--baseline", base, "--out", out);
  app.setVariant("");
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /\| \/ \| desktop \| scroller-1 \|/);
  assert.ok((await readdir(join(out, "diff"))).includes("root__desktop__scroller-1.png"));

  const legacy = await tmp("cli-legacy");
  const alias = await cli("baseline-capture", "--url", app.url, "--out", legacy, "--changed-target", "/about-us");
  assert.equal(alias.status, 0, alias.stderr);
  assert.deepEqual(
    await readdir(join(legacy, "about-us")).catch(() => []),
    ["desktop.png", "mobile.png"],
    "legacy path <route>/<viewport>.png, for the route named by --changed-target",
  );

  const broken = await cli("baseline", "capture", "--url", app.url, "--route", "/boom", "--out", await tmp("cli-boom"));
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /\/boom · \w+: HTTP 500/);
});

test("internal scrollers: info by default (a shell is no defect), a finding on opt-in; verdict stays PASS for info", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shell</title></head><body style="margin:0">
      <main style="width:70vw;height:420px;overflow-y:auto"><div style="height:1200px">Cards</div></main></body></html>`);
    const viewport = { name: "desktop", width: 1000, height: 700 };
    const title = "Tall content trapped in an internal scroller";
    const byDefault = (await runLayoutChecks(page, viewport)).find((i) => i.title === title);
    assert.equal(byDefault.severity, "info");
    const optIn = (await runLayoutChecks(page, viewport, { internalScrollers: "finding" })).find((i) => i.title === title);
    assert.equal(optIn.severity, "medium");
  } finally {
    await browser.close();
  }
});

test("explore --baseline-dir: one stray pixel passes at the default threshold, fails at 0", async () => {
  const outA = await tmp("ex-a");
  const baselineDir = await tmp("ex-base");
  const viewports = [{ name: "desktop", width: 1280, height: 800 }];
  const bounds = { max_states: 2, max_depth: 1, max_actions_per_state: 2, max_total_actions: 4, max_runtime_ms: 60_000 };
  const url = `${app.url}/short`;
  // Run once against a white image to get explore's own first-view screenshot.
  const white = new PNG({ width: 1280, height: 800 });
  white.data.fill(255);
  await (await import("node:fs/promises")).writeFile(join(baselineDir, "desktop.png"), PNG.sync.write(white));
  await explore({ baseUrl: url, outDir: outA, baselineDir, viewports, bounds });
  const shot = (await readdir(join(outA, "screenshots"))).find((f) => f.startsWith("initial-desktop"));
  const image = PNG.sync.read(await readFile(join(outA, "screenshots", shot)));
  image.data.set([0, 0, 0, 255], (700 * image.width + 900) * 4); // one pixel, empty area
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(baselineDir, "desktop.png"), PNG.sync.write(image));
  const differs = (report) => report.issues.some((i) => i.title === "Initial render differs from baseline");
  const byDefault = await explore({ baseUrl: url, outDir: await tmp("ex-b"), baselineDir, viewports, bounds });
  assert.equal(differs(byDefault), false, "1 px of 1.0M is far below the default threshold");
  const strict = await explore({
    baseUrl: url, outDir: await tmp("ex-c"), baselineDir, viewports, bounds, baseline: { threshold_pct: 0 },
  });
  assert.equal(differs(strict), true, "threshold 0 sees the pixel");
});
