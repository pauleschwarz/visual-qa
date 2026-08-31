import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { explore } from "../src/explore.mjs";
import { run } from "../src/run.mjs";

// The fixture intentionally separates risk classes: a destructive label with
// an innocent handler, a submit control with an innocent label, and a plain
// safe toggle.
const CONTROLS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Controls</title></head>
<body><h1>Controls</h1>
<button id="boom">Delete account</button>
<form id="f"><label for="q">Query</label><input id="q" type="text"><button type="submit" id="go">Continue</button></form>
<p id="state">Draft.</p>
<script>
boom.onclick=()=>{state.textContent='deleted';};
f.onsubmit=(e)=>{e.preventDefault();state.textContent='submitted';};
</script></body></html>`;

const SMALL_BOUNDS = {
  max_states: 5,
  max_depth: 2,
  max_actions_per_state: 6,
  max_total_actions: 20,
  max_runtime_ms: 60_000,
};

async function serve(html) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/`;
}

test("mode off reports an explicitly incomplete run without a browser walk", async () => {
  const outDir = await mkdtemp(`${tmpdir()}/vqa-modes-off-`);
  try {
    const report = await run({ mode: "off", outDir });
    assert.equal(report.mode, "off");
    assert.equal(report.verdict, "COVERAGE_INCOMPLETE");
    assert.equal(report.complete, false);
    assert.equal(report.coverage.limit_reason, "mode_off");
    assert.equal(report.coverage.states, 0);
    assert.equal(report.coverage.actions, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("unreachable targets surface as explicit viewport errors, not silence", async () => {
  const outDir = await mkdtemp(`${tmpdir()}/vqa-modes-dead-`);
  try {
    const report = await explore({
      baseUrl: "http://127.0.0.1:9/",
      outDir,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: { ...SMALL_BOUNDS, max_runtime_ms: 15_000 },
    });
    assert.equal(report.verdict, "COVERAGE_INCOMPLETE");
    assert.equal(report.complete, false);
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.type === "vqa-explorer" &&
          issue.title === "Viewport walk failed",
      ),
      "navigation failure must appear as an issue",
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("action security skips destructive and mutating controls until explicitly allowed", async () => {
  const baseUrl = await serve(CONTROLS_HTML);
  const outDir = await mkdtemp(`${tmpdir()}/vqa-sec-deny-`);
  try {
    const report = await explore({
      baseUrl,
      outDir,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: SMALL_BOUNDS,
    });
    const destructive = report.evidence.find(
      (entry) => entry.control?.name === "Delete account",
    );
    assert.equal(destructive?.status, "skipped");
    assert.equal(destructive?.skip_reason, "DESTRUCTIVE_ACTION_NOT_ALLOWED");
    const submit = report.evidence.find(
      (entry) => entry.control?.name === "Continue",
    );
    assert.equal(submit?.status, "skipped");
    assert.equal(submit?.skip_reason, "MUTATING_ACTION_NOT_ALLOWED");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    void baseUrl;
  }
});

test("isolated environments with explicit allowance execute the same controls", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CONTROLS_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outDir = await mkdtemp(`${tmpdir()}/vqa-sec-allow-`);
  try {
    const report = await explore({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      isolatedEnvironment: true,
      allowDestructive: true,
      securityChecks: false,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: SMALL_BOUNDS,
    });
    const destructive = report.evidence.find(
      (entry) => entry.control?.name === "Delete account",
    );
    assert.equal(destructive?.status, "observed");
    const submit = report.evidence.find(
      (entry) => entry.control?.name === "Continue",
    );
    assert.equal(submit?.status, "observed");
  } finally {
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
});

test("a missing baseline is missing coverage and can never pass", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CONTROLS_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outDir = await mkdtemp(`${tmpdir()}/vqa-baseline-missing-`);
  const baselineDir = await mkdtemp(`${tmpdir()}/vqa-baseline-dir-`);
  try {
    const report = await explore({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      baselineDir,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: SMALL_BOUNDS,
    });
    assert.equal(report.verdict, "COVERAGE_INCOMPLETE");
    assert.equal(report.coverage.limit_reason, "baseline_missing");
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.type === "vqa-baseline" &&
          issue.evidence?.reason === "baseline_missing",
      ),
      "baseline_missing must be a recorded issue",
    );
  } finally {
    server.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(baselineDir, { recursive: true, force: true });
  }
});

test("a differing baseline is recorded as a render difference", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CONTROLS_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outDir = await mkdtemp(`${tmpdir()}/vqa-baseline-diff-`);
  const baselineDir = await mkdtemp(`${tmpdir()}/vqa-baseline-diff-dir-`);
  try {
    const { PNG } = await import("pngjs");
    const png = new PNG({ width: 1280, height: 800 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 255;
      png.data[i + 3] = 255;
    }
    await writeFile(
      join(baselineDir, "desktop.png"),
      PNG.sync.write(png),
    );
    const report = await explore({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      baselineDir,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: SMALL_BOUNDS,
    });
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.type === "vqa-baseline" &&
          issue.title === "Initial render differs from baseline",
      ),
      "the render difference must be recorded",
    );
  } finally {
    server.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(baselineDir, { recursive: true, force: true });
  }
});

test("changed mode walks only the declared targets", async () => {
  const otherHtml = CONTROLS_HTML.replace("Controls</h1>", "Other page</h1>");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/other" ? otherHtml : CONTROLS_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outDir = await mkdtemp(`${tmpdir()}/vqa-changed-`);
  try {
    const report = await explore({
      baseUrl: `http://127.0.0.1:${port}/`,
      mode: "changed",
      changedTargets: [`http://127.0.0.1:${port}/other`],
      outDir,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: SMALL_BOUNDS,
    });
    assert.ok(report.states.length >= 1, "target state was explored");
    assert.ok(
      report.states.some((state) => (state.url || "").endsWith("/other")),
      "the declared target is covered",
    );
    assert.ok(
      report.states.every((state) => (state.url || "").includes("/other")),
      "the undeclared root page is never walked",
    );
  } finally {
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
});
