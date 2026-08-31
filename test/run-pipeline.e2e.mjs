import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/run.mjs";

const BROKEN_HTML =
  '<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body><h1>Demo app</h1><button id="inc">Increment</button><p id="count">0</p><script>let n=0;inc.onclick=()=>{n++;count.textContent=String(n)};</script></body></html>\n';

test("run pipeline applies verified fixes and aggregates report.md", async () => {
  const appDir = await mkdtemp(`${tmpdir()}/vqa-pipeline-app-`);
  const appFile = join(appDir, "index.html");
  await writeFile(appFile, BROKEN_HTML);
  // Serve from disk: the fix stage edits appDir/index.html, and the verify
  // re-explore must observe the fixed document, not a stale constant.
  const server = createServer(async (req, res) => {
    const html = await readFile(appFile, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outDir = await mkdtemp(`${tmpdir()}/vqa-pipeline-out-`);
  const previousKey = process.env.VQA_VISION_API_KEY;
  delete process.env.VQA_VISION_API_KEY;

  try {
    const report = await run({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      fixDir: appDir,
      autofix: "verified",
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: {
        max_states: 5,
        max_depth: 2,
        max_actions_per_state: 5,
        max_total_actions: 20,
        max_runtime_ms: 60_000,
      },
    });

    assert.ok(report.phases.fix?.applied?.length >= 1, "title/lang fixes applied");
    assert.ok(report.phases.verify, "verify phase ran");
    assert.equal(report.phases.vision.status, "skipped_no_calls");
    assert.ok(
      !report.issues.some((i) => i.evidence?.rule === "document-title"),
      "document-title issue cleared after fix",
    );
    assert.ok(
      !report.issues.some((i) => i.evidence?.rule === "html-has-lang"),
      "html-lang issue cleared after fix",
    );
    const fixed = await readFile(appFile, "utf8");
    assert.match(fixed, /<title>/);
    assert.match(fixed, /<html lang="en">/);
    const markdown = await readFile(join(outDir, "report.md"), "utf8");
    assert.match(markdown, /\*\*Verdict:\*\* `/);
  } finally {
    if (previousKey === undefined) delete process.env.VQA_VISION_API_KEY;
    else process.env.VQA_VISION_API_KEY = previousKey;
    server.close();
    await rm(appDir, { recursive: true, force: true });
  }
});

test("run pipeline applies an intent color change and verifies it live", async () => {
  const appDir = await mkdtemp(`${tmpdir()}/vqa-intent-app-`);
  const appFile = join(appDir, "index.html");
  await writeFile(
    appFile,
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Shop</title></head>\n<body><h1>Shop</h1><button id="buy">Add item</button><p id="n">0</p><script>let n=0;buy.onclick=()=>{n++;n.textContent=String(n)};</script></body></html>\n',
  );
  const server = createServer(async (req, res) => {
    const html = await readFile(appFile, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outDir = await mkdtemp(`${tmpdir()}/vqa-intent-out-`);
  try {
    const report = await run({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      fixDir: appDir,
      intent: 'ändere die Farbe von "Add item" auf #16a34a',
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: {
        max_states: 5,
        max_depth: 2,
        max_actions_per_state: 5,
        max_total_actions: 20,
        max_runtime_ms: 60_000,
      },
    });
    assert.equal(report.phases.intent?.parsed, true);
    assert.equal(report.phases.intent?.applied, true);
    assert.ok(report.phases.verify, "verify run executed for the intent");
    // The intent issue existed in the baseline and was cleared by the verify
    // run: the change was followed AND proven against computed styles.
    assert.ok(
      !report.issues.some((item) => item.type === "vqa-intent"),
      "no surviving intent findings",
    );
    assert.ok(report.phases.verify.fixed >= 1);
    const patched = await readFile(appFile, "utf8");
    assert.match(patched, /style="color:#16a34a"/);
    const traceDir = join(outDir, "intent");
    const traced = await readdir(traceDir);
    assert.ok(traced.some((f) => f.endsWith(".before.html")));
    assert.ok(traced.some((f) => f.endsWith(".after.html")));
    assert.ok(report.run_id);
  } finally {
    server.close();
    await rm(appDir, { recursive: true, force: true });
  }
});

test("run pipeline reports an unfulfillable intent instead of hiding it", async () => {
  const appDir = await mkdtemp(`${tmpdir()}/vqa-intent-miss-`);
  const appFile = join(appDir, "index.html");
  await writeFile(
    appFile,
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Shop</title></head>\n<body><p>No button here</p></body></html>\n',
  );
  const server = createServer(async (req, res) => {
    const html = await readFile(appFile, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outDir = await mkdtemp(`${tmpdir()}/vqa-intent-miss-out-`);
  try {
    const report = await run({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      fixDir: appDir,
      intent: 'ändere die Farbe von "Add item" auf rot',
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: {
        max_states: 5,
        max_depth: 2,
        max_actions_per_state: 5,
        max_total_actions: 20,
        max_runtime_ms: 60_000,
      },
    });
    // The target element does not exist: the intent check must surface a
    // high-severity finding, not a silently dropped instruction.
    assert.ok(
      report.issues.some(
        (item) =>
          item.type === "vqa-intent" && item.title === "Intent target not found",
      ),
    );
    assert.equal(report.phases.intent?.applied, false);
  } finally {
    server.close();
    await rm(appDir, { recursive: true, force: true });
  }
});

test("run pipeline without fixDir plans nothing and stays deterministic-only", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(BROKEN_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const outDir = await mkdtemp(`${tmpdir()}/vqa-pipeline-nofix-`);
  const previousKey = process.env.VQA_VISION_API_KEY;
  delete process.env.VQA_VISION_API_KEY;
  try {
    const report = await run({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: {
        max_states: 5,
        max_depth: 2,
        max_actions_per_state: 5,
        max_total_actions: 20,
        max_runtime_ms: 60_000,
      },
    });
    assert.equal(report.phases.fix, undefined);
    assert.equal(report.phases.verify, undefined);
    assert.equal(report.phases.vision.status, "skipped_no_calls");
    assert.ok(report.issues.length > 0, "failures still reported");
  } finally {
    if (previousKey === undefined) delete process.env.VQA_VISION_API_KEY;
    else process.env.VQA_VISION_API_KEY = previousKey;
    server.close();
  }
});
