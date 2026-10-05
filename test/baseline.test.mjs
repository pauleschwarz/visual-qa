// Baselines without a browser: pixel compare, folder diff, config, CLI exits.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { parseVisualQaYaml } from "../src/agent-run.mjs";
import {
  captureBaselines,
  cleanOwnFiles,
  compareFolders,
  compareImages,
  routeKeyFromTarget,
} from "../src/baseline.mjs";
import { compareScreenshots, verdictFor } from "../src/checks.mjs";
import { renderMarkdownReport, summarizeReport } from "../src/report.mjs";
import {
  DEFAULT_PIXEL_THRESHOLD,
  DEFAULT_THRESHOLD_PCT,
  parseViewport,
  resolveBaselineConfig,
  resolveConfig,
} from "../src/config.mjs";

const CLI = new URL("../bin/visual-qa.mjs", import.meta.url).pathname;

/** White PNG with optional [x, y, w, h, [r, g, b]] blocks. */
function png(width, height, blocks = []) {
  const image = new PNG({ width, height });
  image.data.fill(255);
  for (const [bx, by, bw, bh, [r, g, b]] of blocks)
    for (let y = by; y < by + bh; y += 1)
      for (let x = bx; x < bx + bw; x += 1) {
        const i = (y * width + x) * 4;
        image.data.set([r, g, b, 255], i);
      }
  return PNG.sync.write(image);
}

async function put(dir, route, file, buffer) {
  await mkdir(join(dir, route), { recursive: true });
  await writeFile(join(dir, route, file), buffer);
}

const tmp = (name) => mkdtemp(join(tmpdir(), `vqa-${name}-`));

test("route keys: hyphens stay, and two routes that would share a folder are refused before anything runs", async () => {
  assert.equal(routeKeyFromTarget("/", "http://x"), "root");
  assert.equal(routeKeyFromTarget("/about-us", "http://x"), "about-us");
  assert.equal(routeKeyFromTarget("/app/listing", "http://x"), "app-listing");
  const base = { baseUrl: "http://127.0.0.1:1", outDir: await tmp("collide") };
  await assert.rejects(
    captureBaselines({ ...base, targets: ["/a/b", "/a-b"] }),
    /"\/a\/b" and "\/a-b" map to the same folder "a-b"/,
  );
  for (const name of ["../x", "a/b", "mobile.page", "", "-x"])
    await assert.rejects(
      captureBaselines({ ...base, viewports: [{ name, width: 10, height: 10 }] }),
      /viewport name/,
      `viewport "${name}"`,
    );
  await assert.rejects(captureBaselines({ ...base, clock: "yesterday" }), /not an ISO date-time/);
  await assert.rejects(captureBaselines({ outDir: base.outDir }), /requires --url/);
});

test("compareImages: same → 0, one pixel → tiny share, size change is named and counted", () => {
  const a = png(100, 100);
  const same = compareImages(a, png(100, 100));
  assert.equal(same.pixels, 0);
  assert.equal(same.diffPng, null);

  const one = compareImages(a, png(100, 100, [[10, 10, 1, 1, [0, 0, 0]]]));
  assert.equal(one.pixels, 1);
  assert.equal(one.pct, 0.01);
  const diff = PNG.sync.read(one.diffPng);
  const at = (10 * 100 + 10) * 4;
  assert.deepEqual([...diff.data.slice(at, at + 3)], [255, 0, 0], "changed pixel is red");

  const grown = compareImages(a, png(100, 120));
  assert.equal(grown.sizeChanged, true);
  assert.deepEqual([grown.sizeA, grown.sizeB], [[100, 100], [100, 120]]);
  assert.ok(grown.pixels > 0 && grown.diffPng, "added area shows as difference");
});

test("compareScreenshots: threshold in percent, a size change always counts", async () => {
  const dir = await tmp("shots");
  await writeFile(join(dir, "a.png"), png(100, 100));
  await writeFile(join(dir, "b.png"), png(100, 100, [[0, 0, 1, 1, [0, 0, 0]]]));
  await writeFile(join(dir, "c.png"), png(100, 101));
  assert.equal((await compareScreenshots(join(dir, "a.png"), join(dir, "b.png"))).changed, true);
  assert.equal(
    (await compareScreenshots(join(dir, "a.png"), join(dir, "b.png"), { thresholdPct: 0.02 })).changed,
    false,
    "1 px of 10000 is 0.01 %, under 0.02 %",
  );
  assert.equal(
    (await compareScreenshots(join(dir, "a.png"), join(dir, "c.png"), { thresholdPct: 50 })).changed,
    true,
  );
});

test("compareFolders: changed, tiny, resized, new, missing, load error — each named", async () => {
  const base = await tmp("base");
  const next = await tmp("next");
  const block = [[0, 0, 60, 20, [200, 0, 0]]];
  // Same image
  await put(base, "root", "desktop.png", png(200, 200));
  await put(next, "root", "desktop.png", png(200, 200));
  // Changed: a 60×20 block (3 % of 200×200) in a scroller image
  await put(base, "root", "desktop.scroller-1.png", png(200, 200));
  await put(next, "root", "desktop.scroller-1.png", png(200, 200, block));
  // One stray pixel (0.0025 % of 200×200): found at a tight threshold, tolerated at a loose one
  await put(base, "about-us", "mobile.png", png(200, 200));
  await put(next, "about-us", "mobile.png", png(200, 200, [[5, 5, 1, 1, [0, 0, 0]]]));
  // Resized
  await put(base, "long", "mobile.page.png", png(200, 300));
  await put(next, "long", "mobile.page.png", png(200, 320));
  // New and missing
  await put(next, "root", "desktop.scroller-2.png", png(50, 50));
  await put(base, "short", "mobile.png", png(50, 50));
  const manifest = {
    routes: [{ key: "about-us", target: "/about-us" }],
    errors: [{ route: "/boom", viewport: "mobile", message: "HTTP 500" }],
    conditions: { clock: null, locale: "en-US", timezone: "UTC" },
  };
  await writeFile(join(next, "baseline-manifest.json"), JSON.stringify(manifest));

  const r = await compareFolders(base, next, { thresholdPct: 0.001 });
  assert.equal(r.ok, false);
  const found = r.changed.map((e) => `${e.route_key}/${e.viewport}/${e.part}`).sort();
  // 1 px of 40000 = 0.0025 % > 0.001 → found at this threshold; the same must pass at a looser one.
  assert.deepEqual(found, ["about-us/mobile/top", "long/mobile/page", "root/desktop/scroller-1"]);
  const resized = r.changed.find((e) => e.part === "page");
  assert.equal(resized.size_changed, true);
  assert.deepEqual([resized.size_old, resized.size_new], [[200, 300], [200, 320]]);
  assert.equal(r.same, 1);
  assert.deepEqual(r.added.map((e) => e.part), ["scroller-2"]);
  assert.deepEqual(r.missing.map((e) => `${e.route_key}/${e.part}`), ["short/top"]);
  assert.deepEqual(r.errors.map((e) => e.message), ["HTTP 500"]);
  assert.equal(r.changed.find((e) => e.route_key === "about-us").route, "/about-us", "route comes from the manifest, hyphen intact");

  const files = await readdir(join(next, "diff"));
  assert.deepEqual(files.sort(), [
    "about-us__mobile__top.png",
    "long__mobile__page.png",
    "root__desktop__scroller-1.png",
  ]);
  const diffImage = PNG.sync.read(await readFile(join(next, "diff", "root__desktop__scroller-1.png")));
  const inBlock = (10 * 200 + 10) * 4;
  const outside = (100 * 200 + 100) * 4;
  assert.deepEqual([...diffImage.data.slice(inBlock, inBlock + 3)], [255, 0, 0]);
  assert.notDeepEqual([...diffImage.data.slice(outside, outside + 3)], [255, 0, 0]);

  const md = await readFile(join(next, "report.md"), "utf8");
  assert.match(md, /\| \/ \| desktop \| scroller-1 \| 3\.0000 % \(1200 px\) \| 200×200 \| diff\/root__desktop__scroller-1\.png \|/);
  assert.match(md, /200×300 → 200×320/);
  assert.match(md, /## Missing[\s\S]*short · mobile · top/);
  assert.match(md, /## New[\s\S]*scroller-2/);
  assert.match(md, /## Load errors[\s\S]*\/boom · mobile: HTTP 500/);
  const json = JSON.parse(await readFile(join(next, "report.json"), "utf8"));
  assert.equal(json.ok, false);
  assert.equal(json.changed.length, 3);

  // The same folders at a looser threshold: the stray pixel passes, the resize still counts.
  const loose = await compareFolders(base, next, { thresholdPct: 1 });
  assert.deepEqual(
    loose.changed.map((e) => e.part).sort(),
    ["page", "scroller-1"],
    "pixel noise under the threshold is not a finding; size change and the 3 % block are",
  );
});

test("threshold 0: identical pictures are unchanged, one differing pixel is changed", async () => {
  const base = await tmp("zero-a");
  const same = await tmp("zero-b");
  const one = await tmp("zero-c");
  await put(base, "root", "desktop.png", png(50, 50));
  await put(same, "root", "desktop.png", png(50, 50));
  await put(one, "root", "desktop.png", png(50, 50, [[3, 3, 1, 1, [0, 0, 0]]]));
  const identical = await compareFolders(base, same, { thresholdPct: 0 });
  assert.deepEqual([identical.changed.length, identical.same, identical.ok], [0, 1, true]);
  const stray = await compareFolders(base, one, { thresholdPct: 0 });
  assert.deepEqual(stray.changed.map((e) => e.pixels), [1]);
});

test("a size change is a finding even when almost every pixel still matches", async () => {
  const base = await tmp("size-a");
  const next = await tmp("size-b");
  await put(base, "root", "desktop.page.png", png(200, 300));
  await put(next, "root", "desktop.page.png", png(200, 301));
  const r = await compareFolders(base, next, { thresholdPct: 50 });
  assert.equal(r.changed.length, 1, "0.3 % of pixels is far under 50 %, the height still changed");
  assert.equal(r.changed[0].size_changed, true);
  assert.match(r.report, /200×300 → 200×301/);
});

test("compareFolders: identical folders pass, scope limits what must exist, same folder refused", async () => {
  const base = await tmp("same-a");
  const next = await tmp("same-b");
  for (const dir of [base, next]) await put(dir, "root", "desktop.png", png(40, 40));
  await put(base, "other", "desktop.png", png(40, 40));
  await put(base, "root", "tablet.png", png(40, 40));
  const all = await compareFolders(base, next);
  assert.equal(all.ok, false, "baseline images missing in the new folder are an error");
  assert.equal(all.missing.length, 2);
  const scoped = await compareFolders(base, next, {
    scope: { routeKeys: new Set(["root"]), viewports: new Set(["desktop"]) },
  });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.same, 1);
  assert.match(scoped.report, /PASS/);
  await assert.rejects(compareFolders(base, base), /same folder/);
  await assert.rejects(compareFolders(base, next, { outDir: base }), /must not be the baseline folder/);
  await assert.rejects(compareFolders(await tmp("empty"), next), /no baseline images/);
});

test("a one-digit change on a tall page is found, and what stayed below the threshold is reported", async () => {
  const base = await tmp("tall-a");
  const next = await tmp("tall-b");
  // 1440×4000 = 5.8 M px: 0.0005 % of the whole image would tolerate 29 px, a 21 px digit would pass.
  await put(base, "report", "desktop.page.png", png(1440, 4000));
  await put(next, "report", "desktop.page.png", png(1440, 4000, [[100, 3900, 7, 3, [0, 0, 0]]]));
  const found = await compareFolders(base, next, { outDir: await tmp("tall-out") });
  assert.deepEqual(found.changed.map((e) => e.part), ["page"]);
  assert.equal(found.changed[0].pixels, 21);
  // A stray pixel stays below the threshold, and the report says what it let through.
  await put(next, "report", "desktop.page.png", png(1440, 4000, [[100, 3900, 3, 1, [0, 0, 0]]]));
  const out = await tmp("tall-tolerated");
  const tolerated = await compareFolders(base, next, { outDir: out });
  assert.equal(tolerated.ok, true);
  assert.deepEqual(tolerated.tolerated, { images: 1, max_pixels: 3 });
  assert.match(tolerated.report, /Below the threshold, not counted: 1 image differ by at most 3 px/);
  assert.equal(JSON.parse(await readFile(join(out, "report.json"), "utf8")).tolerated.max_pixels, 3);
});

test("a one-step text colour change is found at the default colour distance; the blind spot is a flag away", async () => {
  const a = png(60, 40, [[5, 5, 40, 12, [0x37, 0x41, 0x51]]]);
  const b = png(60, 40, [[5, 5, 40, 12, [0x4b, 0x55, 0x63]]]);
  assert.ok(compareImages(a, b).pixels > 0, "#374151 → #4b5563 differs by default");
  assert.equal(compareImages(a, b, { pixelThreshold: DEFAULT_PIXEL_THRESHOLD * 4 }).pixels, 0, "a coarser distance hides it");
  assert.equal(compareImages(png(60, 40, [[5, 5, 40, 12, [0x33, 0x33, 0x33]]]), png(60, 40, [[5, 5, 40, 12, [0x3a, 0x3a, 0x3a]]])).pixels, 0, "#333 → #3a3a3a stays invisible (README: blind spot)");
  const dir = await tmp("colour");
  await writeFile(join(dir, "a.png"), a);
  await writeFile(join(dir, "b.png"), b);
  assert.equal((await compareScreenshots(join(dir, "a.png"), join(dir, "b.png"))).changed, true);
  assert.equal((await compareScreenshots(join(dir, "a.png"), join(dir, "b.png"), { pixelThreshold: 0.5 })).changed, false);
  assert.equal((await compareScreenshots(join(dir, "a.png"), join(dir, "b.png"), { threshold: 0.5 })).changed, false, "`threshold` is the older name of pixelThreshold");
});

test("compareFolders --out: a foreign folder is refused untouched, an earlier compare's folder is reused, diff/ is never read as a route", async () => {
  const base = await tmp("out-a");
  const next = await tmp("out-b");
  await put(base, "root", "desktop.png", png(100, 100));
  await put(next, "root", "desktop.png", png(100, 100, [[0, 0, 30, 30, [0, 0, 0]]]));
  const foreign = await tmp("out-foreign");
  await put(foreign, "diff", "keep.txt", Buffer.from("user file"));
  await writeFile(join(foreign, "report.md"), "USER REPORT");
  await assert.rejects(compareFolders(base, next, { outDir: foreign }), /refusing/);
  assert.equal(await readFile(join(foreign, "diff", "keep.txt"), "utf8"), "user file");
  assert.equal(await readFile(join(foreign, "report.md"), "utf8"), "USER REPORT");
  // A report.json that is not ours does not make the folder ours.
  await writeFile(join(foreign, "report.json"), JSON.stringify({ schema_version: "something-else" }));
  await assert.rejects(compareFolders(base, next, { outDir: foreign }), /refusing/);
  // The folder of an earlier compare is ours; a second diff into the default folder lists no diff image as "new".
  const out = await tmp("out-own");
  assert.equal((await compareFolders(base, next, { outDir: out })).changed.length, 1);
  assert.equal((await compareFolders(base, next, { outDir: out })).changed.length, 1, "reused");
  const first = await compareFolders(base, next);
  const second = await compareFolders(base, next);
  assert.deepEqual([first.added.length, second.added.length], [0, 0]);
});

test("capture refuses a base URL that answers with a server error, before any old baseline is touched", async () => {
  const server = createServer((req, res) => res.writeHead(500).end("boom"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const out = await tmp("5xx");
  await writeFile(join(out, "baseline-manifest.json"), "{}");
  await put(out, "root", "desktop.png", png(10, 10));
  try {
    await assert.rejects(
      captureBaselines({ baseUrl: `http://127.0.0.1:${server.address().port}`, outDir: out }),
      /does not answer \(HTTP 500\)/,
    );
  } finally {
    server.close();
  }
  assert.deepEqual(await readdir(join(out, "root")), ["desktop.png"]);
});

test("a route that would live in diff/ is refused", async () => {
  await assert.rejects(
    captureBaselines({ baseUrl: "http://127.0.0.1:1", outDir: await tmp("diffroute"), targets: ["/diff"] }),
    /"diff\/"/,
  );
});

test("cleanOwnFiles empties an earlier baseline but never a foreign folder", async () => {
  const foreign = await tmp("foreign");
  await put(foreign, "assets", "logo.png", png(10, 10));
  await assert.rejects(cleanOwnFiles(foreign), /refusing/);
  assert.deepEqual(await readdir(join(foreign, "assets")), ["logo.png"], "foreign png untouched");

  const earlier = await tmp("earlier");
  await writeFile(join(earlier, "baseline-manifest.json"), "{}");
  await put(earlier, "root", "desktop.png", png(10, 10));
  await put(earlier, "root", "desktop.scroller-3.png", png(10, 10));
  await writeFile(join(earlier, "notes.txt"), "keep");
  await mkdir(join(earlier, "diff"));
  await cleanOwnFiles(earlier);
  assert.deepEqual((await readdir(earlier)).sort(), ["notes.txt"], "images, diff, manifest gone; notes.txt kept");
});

test("baseline config: validated keys, viewports as text, defaults measured not zero", () => {
  const empty = resolveBaselineConfig({});
  assert.deepEqual(empty, {
    routes: [],
    viewports: null,
    threshold_pct: DEFAULT_THRESHOLD_PCT,
    pixel_threshold: DEFAULT_PIXEL_THRESHOLD,
    clock: null,
    locale: null,
    timezone: null,
  });
  assert.ok(DEFAULT_THRESHOLD_PCT > 0 && DEFAULT_THRESHOLD_PCT < 0.001);
  const full = resolveBaselineConfig({
    routes: ["/", "/about-us"],
    viewports: ["mobile=390x844", "1280x800"],
    threshold_pct: "0.01",
    clock: "2026-10-05T10:00:00+02:00",
    locale: "de-CH",
    timezone: "Europe/Zurich",
  });
  assert.equal(full.threshold_pct, 0.01);
  assert.deepEqual(full.viewports, [
    { name: "mobile", width: 390, height: 844 },
    { name: "1280x800", width: 1280, height: 800 },
  ]);
  assert.throws(() => resolveBaselineConfig({ threshold_pct: -1 }), /threshold_pct/);
  assert.throws(() => resolveBaselineConfig({ threshold_pct: "abc" }), /threshold_pct/);
  assert.equal(resolveBaselineConfig({ pixel_threshold: "0.2" }).pixel_threshold, 0.2);
  assert.throws(() => resolveBaselineConfig({ pixel_threshold: 2 }), /pixel_threshold/);
  assert.throws(() => resolveBaselineConfig({ pixel_threshold: "x" }), /pixel_threshold/);
  assert.throws(() => resolveBaselineConfig({ clock: "yesterday" }), /clock/);
  assert.throws(() => resolveBaselineConfig({ timezone: "Mars/Base" }), /timezone/);
  assert.throws(() => resolveBaselineConfig({ locale: "not a locale" }), /locale/);
  assert.throws(() => resolveBaselineConfig({ treshold_pct: 1 }), /Unknown baseline key "treshold_pct"/);
  assert.throws(() => resolveBaselineConfig({ routes: ["/", " "] }), /empty/);
  assert.throws(() => parseViewport("wide"), /name=390x844/);
  assert.equal(resolveConfig({}).baseline.threshold_pct, DEFAULT_THRESHOLD_PCT);
  assert.equal(resolveConfig({}).internalScrollers, "info");
  assert.equal(resolveConfig({ internalScrollers: "finding" }).internalScrollers, "finding");
});

test(".visual-qa.yml baseline block: lists, viewports, scalars; hyphen routes intact", () => {
  const parsed = parseVisualQaYaml(`
route_map:
  src/**: FULL
baseline:
  routes:
    - /
    - /about-us
  viewports:
    - mobile: 390x844
    - 1280x800
  threshold_pct: 0.01
  clock: 2026-10-05T10:00:00+02:00
  locale: de-CH
  timezone: Europe/Zurich
max_review_fix_loops: 3
`);
  assert.equal(parsed.max_review_fix_loops, 3);
  assert.deepEqual(parsed.route_map, { "src/**": "FULL" });
  assert.deepEqual(parsed.baseline.routes, ["/", "/about-us"]);
  assert.deepEqual(parsed.baseline.viewports, ["mobile=390x844", "1280x800"]);
  assert.equal(parsed.baseline.clock, "2026-10-05T10:00:00+02:00");
  const cfg = resolveBaselineConfig(parsed.baseline);
  assert.equal(cfg.threshold_pct, 0.01);
  assert.equal(cfg.timezone, "Europe/Zurich");
  assert.deepEqual(parseVisualQaYaml("baseline:\n  routes: [/, /pricing]\n").baseline.routes, ["/", "/pricing"]);
  assert.deepEqual(parseVisualQaYaml("trigger:\n  - a\n").baseline, {});
});

test("verdict: info is noted but cannot hold a PASS or hide a real finding", () => {
  const info = { severity: "info" };
  assert.equal(verdictFor({ issues: [info], complete: true }), "PASS");
  assert.equal(verdictFor({ issues: [info, { severity: "medium" }], complete: true }), "UNPROVEN");
  assert.equal(verdictFor({ issues: [info, { severity: "high" }], complete: true }), "FAIL");
  assert.equal(verdictFor({ issues: [info], complete: false }), "COVERAGE_INCOMPLETE");
});

test("report: an info note is listed after the real findings, with its own count", () => {
  const issue = (severity, title) => ({ issue_id: `i-${title}`, type: "vqa-visual", severity, title, detail: "d", evidence: {} });
  const report = {
    verdict: "PASS",
    complete: true,
    issues: [issue("info", "Shell scrolls inside"), issue("medium", "Real problem")],
  };
  const md = renderMarkdownReport(report);
  assert.match(md, /### MEDIUM[\s\S]*Real problem[\s\S]*### INFO[\s\S]*Shell scrolls inside/);
  assert.deepEqual(summarizeReport(report).by_severity, { medium: 1, info: 1 });
  assert.equal(summarizeReport(report).issues[0].severity, "medium");
});

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("the threshold default is written down once and quoted the same everywhere", async () => {
  const help = cli("--help").stdout;
  assert.match(help, new RegExp(`--threshold-pct N .*default ${DEFAULT_THRESHOLD_PCT}\\)`));
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(`default \`${DEFAULT_THRESHOLD_PCT}\``), "README names the default");
  assert.ok(readme.includes(`threshold_pct: ${DEFAULT_THRESHOLD_PCT}`), "README config example uses it");
  assert.match(help, new RegExp(`--pixel-threshold N .*default ${DEFAULT_PIXEL_THRESHOLD}\\)`));
  assert.ok(readme.includes(`default \`${DEFAULT_PIXEL_THRESHOLD}\``), "README names the colour distance default");
  assert.ok(readme.includes(`pixel_threshold: ${DEFAULT_PIXEL_THRESHOLD}`), "README config example uses it");
});

test("CLI baseline: wrong calls exit 2 with a reason, nothing touched", async () => {
  const cases = [
    [["baseline"], /expected capture, compare or diff/],
    [["baseline", "snap"], /expected capture, compare or diff, got "snap"/],
    [["baseline", "capture"], /requires --url/],
    [["baseline", "capture", "--url", "http://x", "--threshold-pct", "1"], /does not apply/],
    [["baseline", "capture", "--url", "http://x", "extra"], /unexpected argument extra/],
    [["baseline", "compare", "--url", "http://x"], /requires --baseline/],
    [["baseline", "diff", "only-one"], /exactly two folders/],
    [["baseline", "diff", "--url", "http://x", "a", "b"], /does not apply/],
    [["baseline", "capture", "--url"], /requires a value/],
    [["baseline", "capture", "--url", "http://x", "--viewport", "wide"], /name=390x844/],
    [["baseline", "capture", "--url", "http://x", "--clock", "yesterday"], /clock/],
    [["baseline-capture"], /requires --url/],
    [["explore", "--url", "http://127.0.0.1:1", "--pixel-threshold", "2"], /pixel_threshold/],
  ];
  for (const [args, pattern] of cases) {
    const result = cli(...args);
    assert.equal(result.status, 2, `${args.join(" ")} → ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, pattern, args.join(" "));
  }
});

test("CLI baseline: server not answering exits 2 before the old baseline is touched", async () => {
  const out = await tmp("keep");
  await writeFile(join(out, "baseline-manifest.json"), "{}");
  await put(out, "root", "desktop.png", png(10, 10));
  for (const args of [
    ["baseline", "capture", "--url", "http://127.0.0.1:1", "--out", out],
    ["baseline-capture", "--url", "http://127.0.0.1:1", "--out", out],
    ["baseline", "compare", "--url", "http://127.0.0.1:1", "--baseline", out, "--out", await tmp("cmp")],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /does not answer/);
  }
  assert.deepEqual(await readdir(join(out, "root")), ["desktop.png"], "baseline still there");
});

test("CLI baseline diff: exit 0 same, 1 changed; compare folder must differ", async () => {
  const a = await tmp("cli-a");
  const b = await tmp("cli-b");
  await put(a, "root", "desktop.png", png(100, 100));
  await put(b, "root", "desktop.png", png(100, 100));
  const same = cli("baseline", "diff", a, b);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /PASS/);
  await put(b, "root", "desktop.png", png(100, 100, [[0, 0, 30, 30, [0, 0, 0]]]));
  const changed = cli("baseline", "diff", a, b, "--threshold-pct", "0.1");
  assert.equal(changed.status, 1);
  // The colour distance is a flag too: at colour distance 1 black against white no longer differs.
  assert.equal(cli("baseline", "diff", a, b, "--pixel-threshold", "1").status, 0);
  assert.equal(cli("baseline", "diff", a, b, "--pixel-threshold", "2").status, 2);
  assert.match(changed.stdout, /\| \/ \| desktop \| top \| 9\.0000 %/);
  const foreign = await tmp("cli-foreign");
  await put(foreign, "diff", "keep.txt", Buffer.from("user file"));
  const refused = cli("baseline", "diff", a, b, "--out", foreign);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refusing/);
  assert.equal(await readFile(join(foreign, "diff", "keep.txt"), "utf8"), "user file", "--out never deletes a foreign diff/");
  assert.equal(cli("baseline", "diff", a, a).status, 2);
  assert.match(cli("baseline", "diff", a, a).stderr, /same folder/);
  assert.equal(cli("baseline", "diff", a, await tmp("cli-empty")).status, 1, "no images in the new folder = everything missing");
});
