import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
