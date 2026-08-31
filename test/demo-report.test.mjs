import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { demo } from "../src/demo.mjs";
import { renderSummaryLines, summarizeReport } from "../src/report.mjs";

test("demo explores the bundled fixture and finds seeded defects", async () => {
  const outDir = await mkdtemp(`${tmpdir()}/vqa-demo-`);
  const report = await demo({
    outDir,
    bounds: {
      max_states: 8,
      max_depth: 2,
      max_actions_per_state: 4,
      max_total_actions: 12,
      max_runtime_ms: 60_000,
    },
    viewports: [{ name: "desktop", width: 1280, height: 800 }],
  });
  assert.notEqual(report.verdict, "PASS");
  assert.ok(report.issues.length >= 3, "seeded defects found");
  assert.ok(report.issues.some((i) => i.type === "vqa-visual"));
  assert.ok(report.issues.some((i) => i.type === "vqa-slop"));
});

test("summarizeReport gives agents a small actionable contract", () => {
  const summary = summarizeReport({
    verdict: "FAIL",
    run_id: "abc12345",
    complete: true,
    coverage: {
      states: 3,
      actions: 7,
      viewports_covered: ["mobile"],
      limit_reason: null,
    },
    issues: [
      {
        issue_id: "vqa-runtime-unhandled-page-error",
        type: "vqa-runtime",
        severity: "critical",
        title: "Unhandled page error",
        detail: "boom",
      },
      {
        issue_id: "vqa-slop-lorem-ipsum-placeholder-copy",
        type: "vqa-slop",
        severity: "high",
        title: "Lorem ipsum placeholder copy",
        detail: "lorem",
      },
      {
        issue_id: "x",
        type: "vqa-x",
        severity: "low",
        title: "minor",
        detail: "x",
      },
    ],
    phases: { vision: { status: "skipped_no_calls", issues: 0 } },
  });
  assert.equal(summary.verdict, "FAIL");
  assert.equal(summary.issue_count, 3);
  assert.deepEqual(summary.by_severity, { critical: 1, high: 1, low: 1 });
  assert.equal(summary.issues.length, 3);
  assert.equal(summary.issues[0].id, "vqa-runtime-unhandled-page-error");
  assert.equal(summary.artifacts.report_md, "report.md");
  const lines = renderSummaryLines(summary);
  assert.ok(lines[0].includes("Visual QA FAIL"));
  assert.ok(lines.some((l) => l.includes("vqa-runtime-unhandled-page-error")));
});

test("summarizeReport tolerates an empty report shape", () => {
  const summary = summarizeReport({});
  assert.equal(summary.verdict, undefined);
  assert.equal(summary.issue_count, 0);
  assert.deepEqual(summary.by_severity, {});
  assert.deepEqual(summary.issues, []);
});
