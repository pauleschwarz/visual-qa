// Geometry: option parsing, issue mapping and CLI errors — nothing here starts a browser.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_GEOMETRY_CHECKS,
  GEOMETRY_CHECKS,
  geometryExitCode,
  geometryIssues,
  parseSelectorFlags,
  parseSweep,
  resolveChecks,
  sweepWidths,
} from "../src/geometry.mjs";

const CLI = resolve(import.meta.dirname, "..", "bin", "visual-qa.mjs");
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 30_000 });

test("sweep: FROM-TO[:STEP], TO is always measured, bad ranges are refused", () => {
  assert.deepEqual(parseSweep("320-1440:40"), { from: 320, to: 1440, step: 40 });
  assert.equal(parseSweep("320-1440").step, 40);
  assert.deepEqual(sweepWidths({ from: 320, to: 400, step: 40 }), [320, 360, 400]);
  assert.deepEqual(sweepWidths({ from: 320, to: 410, step: 40 }), [320, 360, 400, 410]);
  assert.equal(sweepWidths(parseSweep("320-1440:40")).length, 29);
  for (const bad of ["", "320", "1440-320", "320-1440:0", "100-400", "a-b", "320-1440:x"])
    assert.throws(() => parseSweep(bad), /sweep/, bad);
});

test("selector flags: only first-view and stable take one, and they need CSS", () => {
  assert.deepEqual(parseSelectorFlags(["first-view=.cta", "first-view=h1", "stable=hover:.menu"]), {
    "first-view": [".cta", "h1"],
    stable: ["hover:.menu"],
  });
  // "=" inside the CSS stays in the CSS.
  assert.deepEqual(parseSelectorFlags(['first-view=a[href="/x"]']), { "first-view": ['a[href="/x"]'] });
  for (const bad of ["covered=.x", "first-view", "first-view=", "=x"])
    assert.throws(() => parseSelectorFlags([bad]), /--selector/, bad);
});

test("checks: default set needs no input, first-view and stable join when their selector is given, unknown and unfed names fail", () => {
  assert.deepEqual(resolveChecks(undefined, {}), DEFAULT_GEOMETRY_CHECKS);
  assert.ok(!DEFAULT_GEOMETRY_CHECKS.includes("first-view") && !DEFAULT_GEOMETRY_CHECKS.includes("stable"));
  assert.deepEqual(resolveChecks(undefined, { "first-view": [".x"] }), [...DEFAULT_GEOMETRY_CHECKS, "first-view"]);
  assert.deepEqual(resolveChecks("edges,edges,tap-size", {}), ["edges", "tap-size"]);
  assert.deepEqual(resolveChecks("first-view", { "first-view": [".x"] }), ["first-view"]);
  assert.throws(() => resolveChecks("edges,nope", {}), /unknown geometry check "nope"/);
  assert.throws(() => resolveChecks("stable", {}), /needs --selector stable=CSS/);
  assert.equal(GEOMETRY_CHECKS.length, 7);
});

test("issues: a hit becomes an issue like the other checks, with check, selector, measure and viewport", () => {
  const [item] = geometryIssues(
    [{ check: "edges", kind: "left-edge", severity: "medium", selector: "#second", value: 3, message: "left edge 3 px off" }],
    { viewport: { name: "desktop", width: 1280, height: 800 } },
  );
  assert.equal(item.type, "vqa-geometry");
  assert.equal(item.severity, "medium");
  assert.match(item.title, /edges: #second left edge 3 px off/);
  assert.deepEqual(
    { check: item.evidence.check, selector: item.evidence.selector, value: item.evidence.value, unit: item.evidence.unit, width: item.evidence.viewport.width },
    { check: "edges", selector: "#second", value: 3, unit: "px", width: 1280 },
  );
});

test("exit code: clean 0, finding 1, not measured 2 (also with findings)", () => {
  assert.equal(geometryExitCode({ blocked: false, findings: [] }), 0);
  assert.equal(geometryExitCode({ blocked: false, findings: [{}] }), 1);
  assert.equal(geometryExitCode({ blocked: true, findings: [] }), 2);
  assert.equal(geometryExitCode({ blocked: true, findings: [{}] }), 2);
});

test("cli: a call that cannot run exits 2 with the reason, before any browser", () => {
  const cases = [
    [["geometry"], /geometry requires --url/],
    [["geometry", "--url", "http://x", "--sweep", "9-3"], /sweep "9-3"/],
    [["geometry", "--url", "http://x", "--checks", "nope"], /unknown geometry check "nope"/],
    [["geometry", "--url", "http://x", "--checks", "first-view"], /needs --selector first-view=CSS/],
    [["geometry", "--url", "http://x", "--selector", "edges=.x"], /--selector/],
    [["geometry", "--url", "http://x", "--viewport", "wide"], /viewport "wide"/],
    [["geometry", "--url", "http://x", "--height", "10"], /--height must be a number >= 200/],
    [["geometry", "--url", "http://x", "--bogus"], /flag --bogus does not apply/],
    [["geometry", "--url"], /--url requires a value/],
    [["geometry", "--url", "http://127.0.0.1:1"], /does not answer/],
  ];
  for (const [args, message] of cases) {
    const result = cli(...args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, message, args.join(" "));
  }
});

test("cli: usage names the command and the explore flag", () => {
  const { stdout } = cli("--help");
  assert.match(stdout, /visual-qa geometry --url URL/);
  assert.match(stdout, /--geometry \(run\/explore\)/);
});
