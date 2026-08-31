import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { explore } from "../src/explore.mjs";

const port = 4700 + Math.floor(Math.random() * 100);
const server = spawn(process.execPath, ["fixture/server.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});
test.after(() => server.kill());

await new Promise((resolve) => setTimeout(resolve, 250));

test("fixture yields structured non-PASS report with seeded defects", async () => {
  const outDir = await mkdtemp(`${tmpdir()}/visual-qa-e2e-`);
  const report = await explore({
    baseUrl: `http://127.0.0.1:${port}/`,
    outDir,
    bounds: {
      max_states: 10,
      max_depth: 2,
      max_total_actions: 12,
      max_runtime_ms: 30_000,
    },
  });
  assert.notEqual(report.verdict, "PASS");
  assert.ok(report.issues.some((item) => item.type === "vqa-visual"));
  assert.ok(report.issues.some((item) => item.type === "vqa-slop"));
  assert.ok(
    report.issues.some(
      (item) => item.type === "vqa-runtime" || item.type === "vqa-functional",
    ),
  );
  const saved = JSON.parse(await readFile(join(outDir, "report.json"), "utf8"));
  assert.equal(saved.verdict, report.verdict);
});

test("action and state bounds produce explicit incomplete coverage", async () => {
  const outDir = await mkdtemp(`${tmpdir()}/visual-qa-bounds-`);
  const report = await explore({
    baseUrl: `http://127.0.0.1:${port}/`,
    outDir,
    bounds: {
      max_states: 2,
      max_depth: 2,
      max_total_actions: 1,
      max_runtime_ms: 30_000,
    },
  });
  assert.equal(report.verdict, "COVERAGE_INCOMPLETE");
  assert.equal(report.coverage.limit_reason, "max_total_actions");
});
