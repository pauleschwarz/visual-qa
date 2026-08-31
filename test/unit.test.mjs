import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { dedupeIssues, verdictFor } from "../src/checks.mjs";
import { classifyRisk, redact, resolveConfig } from "../src/config.mjs";
import {
  buildState,
  normalizeUrl,
  sameOrigin,
  scrubVolatile,
} from "../src/state.mjs";

test("redacts credentials and volatile state", () => {
  assert.equal(
    redact({
      password: "secret",
      token: "abc",
      cookie: "x",
      nested: { authorization: "Bearer y" },
    }).password,
    "[REDACTED]",
  );
  assert.equal(
    scrubVolatile("csrf=abc&timestamp=123&name=ok"),
    "csrf=[VOLATILE]&timestamp=[VOLATILE]&name=ok",
  );
});

test("config denies mutating/destructive actions by default", () => {
  assert.equal(classifyRisk("Delete account", "button"), "DESTRUCTIVE");
  assert.equal(
    resolveConfig({ baseUrl: "http://127.0.0.1:1" }).allowMutating,
    false,
  );
  assert.equal(
    resolveConfig({ baseUrl: "http://127.0.0.1:1", isolatedEnvironment: true })
      .allowMutating,
    true,
  );
});

test("hash routes are navigation, volatile fragments are not identity", () => {
  const base = "http://127.0.0.1:4174/";
  assert.notEqual(
    normalizeUrl("http://127.0.0.1:4174/#plate-01", base),
    normalizeUrl("http://127.0.0.1:4174/#plate-02", base),
  );
  assert.equal(
    normalizeUrl("http://127.0.0.1:4174/#id-1234567", base),
    normalizeUrl("http://127.0.0.1:4174/#id-7654321", base),
  );
});

test("origin checks keep exploration inside the SUT", () => {
  assert.equal(
    sameOrigin("http://127.0.0.1:4174/about", "http://127.0.0.1:4174/"),
    true,
  );
  assert.equal(
    sameOrigin("https://example.com/", "http://127.0.0.1:4174/"),
    false,
  );
  assert.equal(
    sameOrigin("mailto:qa@example.invalid", "http://127.0.0.1:4174/"),
    false,
  );
});

test("state identity is stable for volatile values and differs for UI changes", () => {
  const common = {
    url: "http://127.0.0.1:1/?ts=1",
    baseUrl: "http://127.0.0.1:1",
    headings: ["Home"],
    controls: [{ role: "button", name: "Save" }],
    viewport: "desktop",
    theme: "light",
  };
  const a = buildState({ ...common, aria: "- button Save" });
  const b = buildState({
    ...common,
    url: "http://127.0.0.1:1/?ts=2",
    aria: "- button Save",
  });
  const c = buildState({ ...common, aria: "- button Delete" });
  const dark = buildState({ ...common, theme: "dark", aria: "- button Save" });
  const pressed = buildState({
    ...common,
    controls: [{ role: "button", name: "Save", pressed: "true" }],
    aria: "- button Save",
  });
  assert.equal(a.state_id, b.state_id);
  assert.notEqual(a.state_id, c.state_id);
  assert.notEqual(a.state_id, dark.state_id);
  assert.notEqual(a.state_id, pressed.state_id);
});

test("runtime checks report only step deltas with matching severity", async () => {
  const { runRuntimeChecks } = await import("../src/checks.mjs");
  const issues = await runRuntimeChecks({
    baseUrl: "http://127.0.0.1:4174/",
    console: [
      { type: "warning", text: "warn", url: "http://127.0.0.1:4174/" },
      { type: "error", text: "error", url: "http://127.0.0.1:4174/" },
      { type: "error", text: "foreign", url: "https://example.com/" },
    ],
  });
  assert.deepEqual(
    issues.map(({ title, severity }) => [title, severity]),
    [
      ["Browser console warning", "low"],
      ["Browser console error", "high"],
    ],
  );
});

test("duplicate findings collapse and incomplete coverage cannot pass", () => {
  const issue = {
    type: "vqa-runtime",
    title: "x",
    detail: "y",
    severity: "high",
  };
  assert.equal(dedupeIssues([issue, { ...issue }]).length, 1);
  assert.equal(
    verdictFor({ issues: [], complete: false }),
    "COVERAGE_INCOMPLETE",
  );
  assert.equal(verdictFor({ issues: [issue], complete: true }), "FAIL");
});

test("temporary evidence directory can be created", async () => {
  const dir = await mkdtemp(`${tmpdir()}/visual-qa-`);
  await writeFile(`${dir}/evidence.json`, "{}\n");
  assert.ok(dir);
});

test("mode is an explicit contract, not a silent full-run default", () => {
  assert.equal(resolveConfig({ baseUrl: "http://127.0.0.1:1" }).mode, "full");
  assert.equal(resolveConfig({ mode: "off" }).mode, "off");
  assert.throws(
    () => resolveConfig({ baseUrl: "http://127.0.0.1:1", mode: "everything" }),
    /Unknown mode/,
  );
  assert.throws(
    () => resolveConfig({ baseUrl: "http://127.0.0.1:1", mode: "changed" }),
    /changed-target/,
  );
  const changed = resolveConfig({
    baseUrl: "http://127.0.0.1:1",
    mode: "changed",
    changedTargets: ["/pricing", "  "],
  });
  assert.deepEqual(changed.changedTargets, ["/pricing"]);
});

test("submit controls are mutating regardless of their label", () => {
  assert.equal(classifyRisk("Continue", "button", "submit"), "MUTATING");
  assert.equal(classifyRisk("Continue", "button", "button"), "SAFE");
  assert.equal(classifyRisk("Delete account", "button", "submit"), "DESTRUCTIVE");
});

test("destructive actions need isolation plus explicit allowance", () => {
  const isolated = { baseUrl: "http://127.0.0.1:1", isolatedEnvironment: true };
  assert.equal(resolveConfig(isolated).allowDestructive, false);
  assert.equal(
    resolveConfig({ ...isolated, allowDestructive: true }).allowDestructive,
    true,
  );
  assert.equal(
    resolveConfig({ allowDestructive: true }).allowDestructive,
    false,
  );
});

test("identical screenshots compare clean, differing ones do not", async () => {
  const { compareScreenshots } = await import("../src/checks.mjs");
  const { PNG } = await import("pngjs");
  const dir = await mkdtemp(`${tmpdir()}/visual-qa-png-`);
  const make = (path, color) => {
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = color[0];
      png.data[i + 1] = color[1];
      png.data[i + 2] = color[2];
      png.data[i + 3] = 255;
    }
    return writeFile(path, PNG.sync.write(png));
  };
  await make(`${dir}/a.png`, [255, 0, 0]);
  await make(`${dir}/b.png`, [255, 0, 0]);
  await make(`${dir}/c.png`, [0, 0, 255]);
  assert.deepEqual(await compareScreenshots(`${dir}/a.png`, `${dir}/b.png`), {
    changed: false,
    ratio: 0,
    pixels: 0,
  });
  const diff = await compareScreenshots(`${dir}/a.png`, `${dir}/c.png`);
  assert.equal(diff.changed, true);
  assert.ok(diff.ratio > 0);
});
