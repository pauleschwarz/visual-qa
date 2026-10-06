// Geometry in a real browser: every check finds its built-in defect (fixture/geometry-app.mjs), stays quiet on its twin
// without it, and the whole run holds together (sweep, images, report, states, load errors, CLI, explore).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { startGeometryApp } from "../fixture/geometry-app.mjs";
import { DEMO_HTML } from "../src/demo-html.mjs";
import { explore } from "../src/explore.mjs";
import { chromium } from "playwright";
import { geometry, geometryExitCode, geometryFindings, parseSweep } from "../src/geometry.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const app = await startGeometryApp();
test.after(() => app.close());

const tmp = (name) => mkdtemp(join(tmpdir(), `vqa-geo-${name}-`));
const PHONE = { name: "phone", width: 390, height: 700 };
const DESKTOP = { name: "desktop", width: 1280, height: 800 };

/** One geometry run on a fixture route; the viewports default to a phone and a desktop. */
async function run(route, checks, extra = {}) {
  return geometry({
    baseUrl: app.url,
    outDir: await tmp("out"),
    routes: [route],
    viewports: [PHONE, DESKTOP],
    checks,
    selectors: {},
    ...extra,
  });
}

const kinds = (result) => result.findings.map((f) => `${f.check}/${f.kind}`).sort();
const bySelector = (result, selector) => result.findings.find((f) => f.selector === selector);

/** The same call must come back clean on the twin page and red on the defective one. */
async function pair(name, checks, extra) {
  const bad = await run(`/${name}-bad`, checks, extra);
  const ok = await run(`/${name}-ok`, checks, extra);
  assert.deepEqual(ok.errors, [], `${name}-ok errors`);
  assert.deepEqual(kinds(ok), [], `${name}-ok must be clean`);
  assert.equal(ok.ok, true);
  assert.deepEqual(bad.errors, [], `${name}-bad errors`);
  assert.equal(bad.ok, false);
  return { bad, ok };
}

test("first-view: the CTA below the fold is found, with how far; the twin is clean — and found only in a window too short for it", async () => {
  const sel = { "first-view": [".cta"] };
  const { bad } = await pair("first-view", ["first-view"], { selectors: sel });
  const cta = bad.findings[0];
  assert.deepEqual([cta.check, cta.kind, cta.selector, cta.severity], ["first-view", "below-fold", ".cta", "high"]);
  // Bottom at ~818 px; the shorter window misses it by more.
  assert.ok(cta.measure.value > 100, `${cta.measure.value}`);
  assert.equal(cta.worst.height, 700);
  assert.match(cta.message, /below the fold/);
  // Short windows: the twin's CTA ends at ~190 px, so a 150 px window loses it and a 400 px one does not.
  const short = await run("/first-view-ok", ["first-view"], {
    selectors: sel,
    viewports: [{ name: "tall", width: 1280, height: 400 }, { name: "short", width: 1280, height: 150 }],
  });
  assert.deepEqual(short.findings.map((f) => [f.kind, f.worst.viewport, f.viewports]), [["below-fold", "short", ["short"]]]);
  assert.ok(short.findings[0].measure.value > 20 && short.findings[0].measure.value < 80);
});

test("first-view: a selector that matches nothing, or is invalid, is a finding — not a pass", async () => {
  const result = await run("/first-view-ok", ["first-view"], { selectors: { "first-view": [".missing", "a[["] } });
  assert.deepEqual(kinds(result), ["first-view/bad-selector", "first-view/not-found"]);
  assert.equal(result.ok, false);
});

test("covered: a fixed header and bar over content no scrolling clears are found; the twin with room is clean", async () => {
  const { bad } = await pair("covered", ["covered"]);
  const first = bySelector(bad, "#first");
  const last = bySelector(bad, "#last");
  assert.equal(first.kind, "covers-content");
  assert.equal(first.measure.value, 100);
  assert.match(first.measure.covered_by, /header/);
  assert.match(last.measure.covered_by, /div/);
  assert.equal(last.severity, "high");
});

test("covered: a link that only lands under the bar when the browser focuses it is found; scroll-padding clears it", async () => {
  const { bad } = await pair("covered-focus", ["covered"]);
  assert.deepEqual(kinds(bad), ["covered/covers-focus"]);
  assert.equal(bad.findings[0].selector, "#deep");
  assert.match(bad.findings[0].message, /once the browser has scrolled it into view/);
});

test("stable: a label change that pushes the neighbour is found with its distance; a fixed width is clean; hover works too", async () => {
  const sel = { stable: ["#save"] };
  const { bad } = await pair("stable", ["stable"], { selectors: sel });
  const moved = bad.findings[0];
  assert.deepEqual([moved.check, moved.kind, moved.selector, moved.trigger], ["stable", "moves", "#cancel", "#save"]);
  assert.ok(moved.measure.dx > 50 && moved.measure.dy === 0, JSON.stringify(moved.measure));
  const hover = await run("/stable-hover-bad", ["stable"], { selectors: { stable: ["hover:.menu"] } });
  assert.deepEqual(hover.findings.map((f) => [f.selector, f.measure.dy]), [["#after", 60]]);
});

test("stable: a trigger that matches nothing is an error (exit 2), never a clean page", async () => {
  const result = await run("/stable-ok", ["stable"], { selectors: { stable: ["#nothing"] } });
  assert.equal(result.blocked, true);
  assert.match(result.errors[0].message, /stable #nothing: stable trigger "#nothing" matches nothing/);
});

test("edges: 3 px off the card above is found; flush and a deliberate 24 px indent are not", async () => {
  const { bad } = await pair("edges", ["edges"]);
  const edge = bad.findings[0];
  assert.deepEqual([edge.kind, edge.selector, edge.measure.value, edge.severity], ["left-edge", "#second", 3, "medium"]);
  // The band is 1–4 px: the boundaries decide it.
  const seen = {};
  for (const px of [0, 1, 4, 5]) {
    app.setShift(px);
    seen[px] = (await run("/edges-shift", ["edges"], { viewports: [DESKTOP] })).findings.length;
  }
  assert.deepEqual(seen, { 0: 0, 1: 1, 4: 1, 5: 0 });
  app.setShift(0);
});

test("text-fit: cut text, an ellipsis without a title and text sticking out are found, with px; the twin is clean", async () => {
  const { bad } = await pair("text-fit", ["text-fit"]);
  const found = Object.fromEntries(bad.findings.map((f) => [f.kind, f]));
  assert.deepEqual(Object.keys(found).sort(), ["ellipsis-no-title", "text-cut", "text-overflow"]);
  assert.equal(found["text-cut"].severity, "high");
  assert.match(found["text-cut"].selector, /chip/);
  assert.match(found["ellipsis-no-title"].selector, /name/);
  assert.match(found["text-overflow"].selector, /btn/);
  for (const f of bad.findings) assert.ok(f.measure.value > 0 && f.measure.unit === "px");
});

test("row-align: two texts 2 px apart and two same-sized texts with baselines 3 px off are found; the twin is clean; --min-gap decides the first", async () => {
  const { bad } = await pair("row-align", ["row-align"]);
  const gap = bad.findings.find((f) => f.kind === "gap");
  const base = bad.findings.find((f) => f.kind === "baseline");
  assert.equal(gap.measure.value, 2);
  assert.ok(base.measure.value >= 2.5 && base.measure.value <= 3.5, `${base.measure.value}`);
  // 2 px is not below a 2 px minimum: the parameter is the decision.
  const lenient = await run("/row-align-bad", ["row-align"], { minGap: 2 });
  assert.deepEqual(lenient.findings.map((f) => f.kind), ["baseline"]);
});

test("tap-size: small targets and overlapping tap areas are found on touch widths only; the twin is clean", async () => {
  const { bad } = await pair("tap-size", ["tap-size"], { viewports: [PHONE] });
  assert.deepEqual(kinds(bad), ["tap-size/overlap", "tap-size/small", "tap-size/small"]);
  const small = bad.findings.filter((f) => f.kind === "small");
  assert.deepEqual(small.map((f) => [f.measure.width, f.measure.height]), [[28, 28], [28, 28]]);
  assert.equal(small[0].severity, "medium");
  const overlap = bySelector(bad, "#two");
  assert.deepEqual([overlap.measure.width, overlap.measure.height], [20, 48]);
  // A desktop width is not a touch width: not run, and the report says so.
  const desktop = await run("/tap-size-bad", ["tap-size"], { viewports: [DESKTOP] });
  assert.deepEqual(kinds(desktop), []);
  assert.deepEqual(desktop.coverage["tap-size"], { ran: 0, of: 1 });
  assert.match(desktop.report, /tap-size ran 0 of 1 times/);
  // …unless the project says its touch widths reach that far.
  assert.ok((await run("/tap-size-bad", ["tap-size"], { viewports: [DESKTOP], touchMax: 1280 })).findings.length >= 3);
});

test("tap-size: a link inside a sentence and a checkbox with its label count as big enough", async () => {
  const ok = await run("/tap-size-ok", ["tap-size"], { viewports: [PHONE] });
  assert.deepEqual(kinds(ok), []);
  assert.deepEqual(ok.coverage["tap-size"], { ran: 1, of: 1 });
});

test("sweep: a defect that exists only at narrow widths is one finding with its range, not 29", async () => {
  const result = await run("/text-fit-sweep", ["text-fit"], { viewports: [], sweep: parseSweep("320-1440:80"), height: 700 });
  assert.equal(result.viewports.length, 15);
  assert.equal(result.findings.length, 1);
  const [chip] = result.findings;
  assert.match(chip.widths, /^320–\d{3}$/, chip.widths);
  assert.ok(Number(chip.widths.split("–")[1]) < 1000);
  assert.equal(chip.worst.width, 320);
  assert.equal(chip.viewports[0], "w320");
});

test("sweep: the worst width of a gap is the narrowest one, and the range ends where the gap reaches the minimum", async () => {
  const result = await run("/row-align-sweep", ["row-align"], { viewports: [], sweep: parseSweep("320-1440:80"), height: 700 });
  assert.equal(result.findings.length, 1);
  const [gap] = result.findings;
  assert.equal(gap.kind, "gap");
  assert.equal(gap.worst.width, 320);
  assert.ok(gap.measure.value > 1 && gap.measure.value < 2, `${gap.measure.value}`);
  assert.match(gap.widths, /^320–1[0-2]\d\d$/, gap.widths);
});

test("a finding has severity, selector, viewport, measure and an image that is a real picture; report.json and report.md carry the same", async () => {
  const result = await run("/text-fit-bad", ["text-fit"]);
  for (const f of result.findings) {
    assert.ok(["high", "medium", "low"].includes(f.severity));
    assert.ok(f.selector && f.worst.width > 0 && f.measure.value > 0);
    assert.ok(f.image, `${f.selector} has no image`);
    const png = PNG.sync.read(await readFile(join(result.outDir, f.image)));
    assert.ok(png.width >= 100 && png.height >= 100);
  }
  const json = JSON.parse(await readFile(join(result.outDir, "report.json"), "utf8"));
  assert.equal(json.schema_version, "vqa-geometry-0.1");
  assert.equal(json.findings.length, result.findings.length);
  assert.equal(json.ok, false);
  const md = await readFile(join(result.outDir, "report.md"), "utf8");
  assert.match(md, /\*\*FAIL\*\*/);
  for (const f of result.findings) assert.ok(md.includes(f.image));
});

test("a page that is empty is clean; a page that does not load is an error in the report, not a crash and not a pass", async () => {
  const blank = await run("/blank", undefined);
  assert.equal(blank.ok, true);
  assert.deepEqual([blank.findings, blank.errors], [[], []]);
  const gone = await run("/nowhere", ["edges"]);
  assert.equal(gone.blocked, true);
  assert.equal(gone.ok, false);
  assert.match(gone.errors[0].message, /HTTP 404/);
  assert.match(await readFile(join(gone.outDir, "report.md"), "utf8"), /\*\*BLOCKED\*\*[\s\S]*## Errors[\s\S]*HTTP 404/);
  // One page measured, one not: the measured one still reports, the run is still not clean.
  const mixed = await run("/edges-bad", ["edges"], { routes: ["/edges-bad", "/nowhere"] });
  assert.equal(mixed.findings.length, 1);
  assert.equal(mixed.blocked, true);
});

test("round trip: found → fixed → clean → broken again → found", async () => {
  const seen = [];
  for (const px of [3, 0, 3]) {
    app.setShift(px);
    const result = await run("/edges-shift", ["edges"], { viewports: [DESKTOP] });
    seen.push(result.findings.map((f) => f.measure.value));
  }
  app.setShift(0);
  assert.deepEqual(seen, [[3], [], [3]]);
});

test("demo app, sweep 320–1440 step 40: under a minute, no finding but the small controls it really has", async () => {
  const demo = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(DEMO_HTML);
  });
  await new Promise((done) => demo.listen(0, "127.0.0.1", done));
  try {
    const started = Date.now();
    const result = await geometry({
      baseUrl: `http://127.0.0.1:${demo.address().port}`,
      outDir: await tmp("demo"),
      routes: ["/"],
      sweep: parseSweep("320-1440:40"),
      selectors: { "first-view": ["h1"] },
      checks: undefined,
    });
    assert.ok(Date.now() - started < 60_000, `${Date.now() - started} ms`);
    assert.equal(result.viewports.length, 29);
    assert.deepEqual(result.errors, []);
    // The demo's buttons, inputs and links are 12–22 px high: those are true findings. Nothing else may fire.
    assert.ok(result.findings.length >= 8);
    for (const f of result.findings) {
      assert.equal(`${f.check}/${f.kind}`, "tap-size/small", `${f.selector}: ${f.message}`);
      assert.ok(f.measure.value < 44);
    }
    assert.ok(result.findings.some((f) => f.selector.includes("tiny") && f.measure.value === 12));
    // Only on touch widths.
    assert.match(result.findings[0].widths, /^320–\d{3}$/);
  } finally {
    demo.close();
  }
});

test("covered: a modal dialog covers the page on purpose — no finding where the same bars would be one", async () => {
  const modal = await run("/covered-modal-ok", ["covered"]);
  assert.deepEqual([modal.findings, modal.errors], [[], []]);
});

test("stable: the trigger moving by itself (a centred label gets wider) is not a neighbour; only the topmost mover of a subtree is reported", async () => {
  const centred = await run("/stable-centered-ok", ["stable"], { selectors: { stable: ["#save"] } });
  assert.deepEqual([centred.findings, centred.errors], [[], []]);
  // /stable-hover-bad: #after and its <b> both move by 60 px — one finding, the parent.
  const hover = await run("/stable-hover-bad", ["stable"], { selectors: { stable: ["hover:.menu"] }, viewports: [DESKTOP] });
  assert.deepEqual(hover.findings.map((f) => f.selector), ["#after"]);
});

test("edges: right edges of two surfaces 3 px apart are found, centred blocks of different width are not", async () => {
  const right = await run("/edges-right-bad", ["edges"], { viewports: [DESKTOP] });
  assert.deepEqual(right.findings.map((f) => [f.kind, f.selector, f.measure.value]), [["right-edge", "#second", 3]]);
  const centred = await run("/edges-center-ok", ["edges"], { viewports: [DESKTOP] });
  assert.deepEqual(centred.findings, []);
});

test("text-fit: a clamped text without a title and a fixed-height box that cuts its text are found; with a title and room they are not", async () => {
  const { bad } = await pair("text-fit-clamp", ["text-fit"], { viewports: [DESKTOP] });
  const found = Object.fromEntries(bad.findings.map((f) => [f.kind, f]));
  assert.deepEqual(Object.keys(found).sort(), ["ellipsis-no-title", "text-cut"]);
  assert.match(found["ellipsis-no-title"].message, /clamped to 2 line/);
  assert.match(found["text-cut"].selector, /box/);
  assert.ok(found["text-cut"].measure.value > 10);
});

test("report: more than ten of a kind list ten and name the rest; the rare kinds still get a picture when the image limit is hit", async () => {
  const result = await run("/tap-size-many", ["tap-size", "row-align"], { viewports: [PHONE] });
  assert.equal(result.findings.length, 47);
  for (const kind of ["overlap", "baseline"]) assert.ok(result.findings.find((f) => f.kind === kind).image, `no picture for ${kind}`);
  assert.equal(result.findings.filter((f) => f.image).length, 40);
  assert.deepEqual(result.warnings, ["images: only the first 40 of 47 findings are photographed"]);
  assert.match(result.report, /Not listed here, see report\.json: 35 more tap-size\/small\./);
  assert.equal(result.report.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length, 12);
});

test("images: a second run in the same folder leaves none of the first run's pictures, and no foreign file", async () => {
  const outDir = await tmp("again");
  const first = await run("/edges-bad", ["edges"], { outDir, viewports: [DESKTOP] });
  assert.equal(first.findings.length, 1);
  await writeFile(join(outDir, "images", "mine.png"), "keep");
  const second = await run("/edges-ok", ["edges"], { outDir, viewports: [DESKTOP] });
  assert.equal(second.findings.length, 0);
  assert.deepEqual((await readdir(join(outDir, "images"))).sort(), ["mine.png"]);
});

// ---------------------------------------------------------------- CLI, states, explore

const runCli = (cwd, ...args) =>
  new Promise((done) =>
    execFile(process.execPath, [join(ROOT, "bin", "visual-qa.mjs"), ...args], { cwd, encoding: "utf8", timeout: 120_000 }, (error, stdout, stderr) =>
      done({ status: error ? error.code : 0, stdout, stderr }),
    ),
  );

test("cli: exit 0 on a clean page, 1 on a finding, 2 when nothing could be measured; report.md and report.json are written", async () => {
  const flags = ["--viewport", "desktop=1280x800", "--checks", "edges"];
  const clean = await runCli(ROOT, "geometry", "--url", app.url, "--route", "/edges-ok", "--out", await tmp("c0"), ...flags);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const out = await tmp("c1");
  const bad = await runCli(ROOT, "geometry", "--url", app.url, "--route", "/edges-bad", "--out", out, ...flags);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /\*\*FAIL\*\*/);
  assert.equal(JSON.parse(await readFile(join(out, "report.json"), "utf8")).findings[0].selector, "#second");
  const gone = await runCli(ROOT, "geometry", "--url", app.url, "--route", "/nowhere", "--out", await tmp("c2"), ...flags);
  assert.equal(gone.status, 2, gone.stdout + gone.stderr);
  assert.match(gone.stdout, /HTTP 404/);
});

test("cli: --selector first-view and stable reach the checks; the sweep flag runs the widths", async () => {
  const out = await tmp("c3");
  const result = await runCli(
    ROOT, "geometry", "--url", app.url, "--route", "/first-view-bad", "--sweep", "400-440:20", "--height", "500",
    "--selector", "first-view=.cta", "--checks", "first-view", "--out", out,
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const json = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  assert.deepEqual(json.viewports.map((v) => [v.width, v.height]), [[400, 500], [420, 500], [440, 500]]);
  assert.equal(json.findings[0].widths, "400–440");
});

test("cli: --min-gap and --touch-max change what is found", async () => {
  const kindsOf = async (...args) => {
    const out = await tmp("c4");
    await runCli(ROOT, "geometry", "--url", app.url, "--out", out, ...args);
    return JSON.parse(await readFile(join(out, "report.json"), "utf8")).findings.map((f) => `${f.check}/${f.kind}`).sort();
  };
  const row = ["--route", "/row-align-bad", "--viewport", "d=1280x800", "--checks", "row-align"];
  assert.deepEqual(await kindsOf(...row), ["row-align/baseline", "row-align/gap"]);
  assert.deepEqual(await kindsOf(...row, "--min-gap", "2"), ["row-align/baseline"]);
  const tap = ["--route", "/tap-size-bad", "--viewport", "d=1280x800", "--checks", "tap-size"];
  assert.deepEqual(await kindsOf(...tap), []);
  assert.deepEqual(await kindsOf(...tap, "--touch-max", "1280"), ["tap-size/overlap", "tap-size/small", "tap-size/small"]);
});

test("states (V1): the page a state's sign-in leaves is what is measured; a plain route beside it stays an anonymous visitor", async () => {
  const dir = await tmp("project");
  // The project's sign-in (global setup) is what turns /edges-ok into a page with a 3 px shift.
  await writeFile(
    join(dir, "hooks.mjs"),
    `export async function setup(page) {
       await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
         document.querySelector("section.card:nth-of-type(2)").style.marginLeft = "3px";
       }));
     }\n`,
  );
  await writeFile(join(dir, ".visual-qa.yml"), "setup: ./hooks.mjs\nstates:\n  shifted:\n    path: /edges-ok\n");
  const flags = ["--viewport", "desktop=1280x800", "--checks", "edges"];
  const plain = await runCli(dir, "geometry", "--url", app.url, "--route", "/edges-ok", "--out", await tmp("s0"), ...flags);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  const out = await tmp("s1");
  const both = await runCli(dir, "geometry", "--url", app.url, "--route", "/edges-ok", "--state", "shifted", "--out", out, ...flags);
  assert.equal(both.status, 1, both.stdout + both.stderr);
  const findings = JSON.parse(await readFile(join(out, "report.json"), "utf8")).findings;
  assert.deepEqual(findings.map((f) => [f.state, f.route, f.measure.value]), [["shifted", "/edges-ok", 3]]);
  const unknown = await runCli(dir, "geometry", "--url", app.url, "--state", "nope", ...flags);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown state "nope"/);
});

test("explore --geometry adds the geometry findings to a state's issues; without it nothing changes", async () => {
  const input = { baseUrl: `${app.url}/edges-bad`, viewports: [DESKTOP], bounds: { max_runtime_ms: 60_000 } };
  const without = await explore({ ...input, outDir: await tmp("x0") });
  assert.deepEqual(without.issues.filter((i) => i.type === "vqa-geometry"), []);
  const withGeometry = await explore({ ...input, outDir: await tmp("x1"), geometry: true });
  const found = withGeometry.issues.filter((i) => i.type === "vqa-geometry");
  assert.ok(found.some((i) => i.evidence.check === "edges" && i.evidence.selector === "#second" && i.evidence.value === 3), JSON.stringify(found));
  // Everything else the run reports is the same.
  const other = (r) => r.issues.filter((i) => i.type !== "vqa-geometry").map((i) => i.issue_id).sort();
  assert.deepEqual(other(withGeometry), other(without));
});

// ---------------------------------------------------------------- what a page can do to a check: scroll, size, navigate

test("tap-size: buttons 40 px apart in a scrolling fixed sheet never overlap, nor do they overlap the page links under the sheet; the two links in it that do are found, once", async () => {
  const result = await run("/tap-size-sheet", ["tap-size"], { viewports: [PHONE] });
  const overlaps = result.findings.filter((f) => f.kind === "overlap");
  assert.deepEqual(overlaps.map((f) => [f.selector, f.selector2, f.measure.width, f.measure.height]), [["#two", "#one", 160, 20]]);
  const small = result.findings.filter((f) => f.kind === "small");
  assert.equal(small.length, 12);
  assert.ok(small.every((f) => f.severity === "high" && f.measure.value === 20), "a 20 px button is high, below 24 px");
});

test("tap-size: the rows of a list that scrolls in a box do not overlap the page links below the box", async () => {
  const result = await run("/tap-size-list", ["tap-size"], { viewports: [PHONE] });
  assert.deepEqual([result.findings, result.errors], [[], []]);
});

test("tap-size: a 20 px button after 250 big links is measured; covered: a link after 400 paragraphs is found under the bar", async () => {
  const late = await run("/tap-size-late", ["tap-size"], { viewports: [PHONE] });
  assert.deepEqual(late.findings.map((f) => [f.selector, f.kind, f.measure.value]), [["#late", "small", 20]]);
  const long = await run("/covered-long", ["covered"], { viewports: [PHONE] });
  assert.equal(bySelector(long, "#last")?.kind, "covers-content");
  assert.deepEqual([long.truncated, long.blocked], [[], false]);
});

test("covered: a page with more content than coveredMax is not measured to the end — blocked, named in the report, never clean", async () => {
  const cut = await run("/covered-long", ["covered"], { viewports: [PHONE, DESKTOP], coveredMax: 100 });
  assert.equal(cut.blocked, true);
  assert.equal(cut.ok, false);
  assert.equal(geometryExitCode(cut), 2);
  assert.equal(cut.truncated.length, 1, "one line for the page, not one per width");
  const [note] = cut.truncated;
  assert.deepEqual([note.check, note.cut, note.label, note.kept, note.viewports], ["covered", "targets", "content elements", 100, ["phone", "desktop"]]);
  assert.ok(note.seen > 400);
  assert.deepEqual(cut.coverage.covered, { ran: 0, of: 2 });
  assert.match(cut.report, /\*\*BLOCKED\*\*/);
  assert.match(cut.report, /## Cut short\n\n- covered measured 100 of \d+ content elements; the rest was not measured \(\/covered-long, 2 viewports, run is BLOCKED\)/);
  const json = JSON.parse(await readFile(join(cut.outDir, "report.json"), "utf8"));
  assert.deepEqual(json.truncated.map((t) => [t.check, t.cut, t.kept]), [["covered", "targets", 100]]);
});

test("a long list of findings keeps the worst of each kind and says how many there were; the rare kind and the high ones stay", async () => {
  const result = await run("/tap-size-cap", ["tap-size"], { viewports: [PHONE] });
  const small = result.findings.filter((f) => f.kind === "small");
  assert.equal(small.length, 100);
  assert.equal(small.filter((f) => f.severity === "high").length, 5, "the five 20 px buttons are the worst: they stay");
  assert.equal(result.findings.filter((f) => f.kind === "overlap").length, 1);
  assert.deepEqual(result.truncated.map((t) => [t.check, t.cut, t.label, t.seen, t.kept]), [["tap-size", "findings", "small", 115, 100]]);
  assert.equal(result.blocked, false, "findings cut by kind still are findings: the run fails on them, it is not 'not measured'");
  assert.equal(result.ok, false);
  assert.match(result.report, /## Cut short\n\n- tap-size\/small: the worst 100 of 115 are kept, the rest are not in the report \(\/tap-size-cap, phone\)/);
  assert.equal(result.report.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length, 11, "ten rows of the small ones, one of the overlap");
  const roomy = await run("/tap-size-cap", ["tap-size"], { viewports: [PHONE], maxPerKind: 200 });
  assert.deepEqual([roomy.findings.length, roomy.truncated], [116, []]);
});

test("explore --geometry: a check cut short is an issue of its own, not silence", async () => {
  const input = { baseUrl: `${app.url}/tap-size-cap`, viewports: [PHONE], bounds: { max_runtime_ms: 60_000 }, geometry: true };
  const found = (await explore({ ...input, outDir: await tmp("x2") })).issues.filter((i) => i.type === "vqa-geometry");
  const cut = found.filter((i) => /cut short/.test(i.title));
  assert.deepEqual(cut.map((i) => [i.title, i.evidence.check, i.severity]), [["Geometry check tap-size/small cut short", "tap-size", "low"]]);
  assert.match(cut[0].detail, /the worst 100 of 115 are kept/);
  assert.equal(found.filter((i) => i.evidence.check === "tap-size" && !/cut short/.test(i.title)).length, 101);
});

test("explore --geometry: a page with more content than covered walks is an issue of its own (medium), the default limit decides", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    await page.goto(`${app.url}/covered-long`);
    const walked = await geometryFindings(page, PHONE);
    assert.ok(walked.some((i) => /#last/.test(i.title)), "the link under the bar is found");
    assert.ok(!walked.some((i) => /cut short/.test(i.title)), "400 paragraphs are walked");
    await page.goto(`${app.url}/covered-huge`);
    const cut = (await geometryFindings(page, PHONE)).filter((i) => /cut short/.test(i.title));
    assert.deepEqual(cut.map((i) => [i.title, i.severity]), [["Geometry check covered cut short", "medium"]]);
    assert.match(cut[0].detail, /covered measured 10000 of 10\d\d\d content elements; the rest was not measured/);
  } finally {
    await browser.close();
  }
});

test("stable: a trigger that navigates away or reloads the page is an error, not 'nothing moved'", async () => {
  for (const route of ["/stable-nav", "/stable-reload"]) {
    const result = await run(route, ["stable"], { selectors: { stable: ["#go"] }, viewports: [DESKTOP] });
    assert.equal(result.blocked, true, route);
    assert.equal(result.ok, false, route);
    assert.match(result.errors[0].message, /the page was replaced after the trigger/, route);
    assert.deepEqual(result.coverage.stable, { ran: 0, of: 1 }, route);
  }
});

test("stable: a trigger below the visible part of a scrolling sheet is scrolled into view first — the rows that scrolled are not movers", async () => {
  const result = await run("/stable-sheet", ["stable"], { selectors: { stable: ["#save"] }, viewports: [PHONE] });
  assert.deepEqual([result.findings, result.errors], [[], []]);
});

test("stable: hover and click are two triggers — hovering Save moves nothing, clicking it does", async () => {
  const hover = await run("/stable-bad", ["stable"], { selectors: { stable: ["hover:#save"] }, viewports: [DESKTOP] });
  assert.deepEqual([hover.findings, hover.errors], [[], []]);
  for (const trigger of ["#save", "click:#save"]) {
    const click = await run("/stable-bad", ["stable"], { selectors: { stable: [trigger] }, viewports: [DESKTOP] });
    assert.deepEqual(click.findings.map((f) => f.selector), ["#cancel"], trigger);
  }
});

test("sweep: a tap area that grows with the window is worst — and high — at the narrowest width, not at the widest", async () => {
  const result = await run("/tap-size-vary", ["tap-size"], { viewports: [], sweep: parseSweep("320-800:80"), height: 700 });
  assert.equal(result.findings.length, 1);
  const [vary] = result.findings;
  assert.deepEqual([vary.worst.width, vary.severity, vary.widths], [320, "high", "320–800"]);
  assert.ok(vary.measure.value >= 16 && vary.measure.value < 24, `the 320 px value, ${vary.measure.value}`);
});

test("tap-size: a link inside a sentence is exempt through <sup>, <em> and <strong> too; a link alone in an <em> is not", async () => {
  const result = await run("/tap-size-wrapped", ["tap-size"], { viewports: [PHONE] });
  assert.deepEqual(result.findings.map((f) => f.selector), ["#alone"]);
});

test("row-align: a table row is no box, a cell spanning rows and a cell centred beside a taller one are placed, not misaligned; a cell 3 px off its row is found", async () => {
  const table = await run("/row-align-table", ["row-align"], { viewports: [DESKTOP] });
  assert.deepEqual(table.findings.map((f) => [f.kind, f.selector, f.measure.value]), [["baseline", "#low", 3], ["baseline", "#low", 3], ["baseline", "#low", 3]]);
  for (const route of ["/row-align-rowspan", "/row-align-span-cell", "/row-align-lines"]) {
    const result = await run(route, ["row-align"], { viewports: [DESKTOP] });
    assert.deepEqual([route, result.findings], [route, []]);
  }
});

test("row-align: boxes far down a row of thirty are compared too; an overlap is high, 2 px apart is medium", async () => {
  const many = await run("/row-align-many", ["row-align"], { viewports: [PHONE] });
  const second = bySelector(many, "#c1");
  assert.deepEqual([second.kind, second.severity, second.measure.value], ["gap", "medium", 2]);
  assert.equal(bySelector(many, "#c0"), undefined, "the first box has nothing before it");
  assert.ok(many.findings.length > 20, `${many.findings.length}`);
  const overlap = await run("/row-align-overlap", ["row-align"], { viewports: [DESKTOP] });
  assert.deepEqual(overlap.findings.map((f) => [f.kind, f.severity, f.measure.value]), [["gap", "high", -20]]);
});

test("edges: the right edges of blocks without a background or border are not an edge, the same blocks with a background are", async () => {
  const plain = await run("/edges-right-plain-ok", ["edges"], { viewports: [DESKTOP] });
  assert.deepEqual(plain.findings, []);
  assert.equal((await run("/edges-right-bad", ["edges"], { viewports: [DESKTOP] })).findings.length, 1);
});

test("first-view: a box lying beyond the picture says where it is; one inside the picture needs no note", async () => {
  const sel = { "first-view": [".cta"] };
  const far = await run("/first-view-far", ["first-view"], { selectors: sel, viewports: [PHONE] });
  const [cta] = far.findings;
  assert.match(cta.image_note, /^the box lies 3060–3106\.4 px down the page, below the 2400 px this picture shows/);
  assert.equal(PNG.sync.read(await readFile(join(far.outDir, cta.image))).height, 2400);
  assert.ok(far.report.includes(`Picture: ${cta.image_note}.`));
  const near = await run("/first-view-bad", ["first-view"], { selectors: sel, viewports: [PHONE] });
  assert.equal(near.findings[0].image_note, undefined);
  assert.doesNotMatch(near.report, /Picture:/);
});

test("cli: run and explore take --geometry — with it the page's geometry findings are issues, without it there are none", async () => {
  for (const command of ["explore", "run"]) {
    const issues = async (...flags) => {
      const out = await tmp("cx");
      const result = await runCli(ROOT, command, "--url", `${app.url}/edges-bad`, "--out", out, "--format", "json", "--max-runtime-ms", "60000", ...flags);
      assert.equal(result.status, 1, `${command} ${flags}: ${result.stderr}`);
      return JSON.parse(result.stdout).issues.filter((i) => i.type === "vqa-geometry");
    };
    const with_ = await issues("--geometry");
    assert.deepEqual(with_.map((i) => [i.where, i.title.slice(0, 33)]), [["#second", "edges: #second left edge 3 px off"]], command);
    assert.deepEqual(await issues(), [], command);
  }
});
