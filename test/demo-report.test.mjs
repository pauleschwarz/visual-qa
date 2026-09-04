import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { demo } from "../src/demo.mjs";
import {
  renderHtmlReport,
  renderSummaryLines,
  summarizeReport,
} from "../src/report.mjs";

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
  const [json, markdown, html] = await Promise.all([
    readFile(join(outDir, "report.json"), "utf8"),
    readFile(join(outDir, "report.md"), "utf8"),
    readFile(join(outDir, "report.html"), "utf8"),
  ]);
  assert.match(json, /"verdict"/);
  assert.match(markdown, /# Visual QA Report/);
  assert.match(html, /Evidence before confidence/);
  assert.match(html, /Built by Paul Schwarz/);
  assert.doesNotMatch(
    html,
    /(?:src|href)="https?:\/\//,
    "portable report has no network assets",
  );
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
  assert.equal(summary.artifacts.report_html, "report.html");
  const lines = renderSummaryLines(summary);
  assert.ok(lines[0].includes("Visual QA FAIL"));
  assert.ok(lines.some((l) => l.includes("vqa-runtime-unhandled-page-error")));
});

test("summaries always prioritize severe findings", () => {
  const low = Array.from({ length: 12 }, (_, index) => ({
    issue_id: `low-${index}`,
    type: "vqa-note",
    severity: "low",
    title: `Low ${index}`,
    detail: "note",
  }));
  const summary = summarizeReport({
    verdict: "FAIL",
    coverage: {},
    issues: [
      ...low,
      {
        issue_id: "critical-last",
        type: "vqa-runtime",
        severity: "critical",
        title: "Critical finding",
        detail: "must stay visible",
      },
    ],
  });
  assert.equal(summary.issues[0].id, "critical-last");
  assert.equal(summary.issues.length, 10);
});

test("HTML report escapes finding content", () => {
  const html = renderHtmlReport({
    verdict: "FAIL",
    complete: true,
    coverage: {},
    issues: [
      {
        issue_id: "unsafe",
        type: "vqa-test",
        severity: "high",
        title: "<script>alert(1)</script>",
        detail: "unsafe & untrusted",
      },
    ],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /unsafe &amp; untrusted/);
});

test("summarizeReport tolerates an empty report shape", () => {
  const summary = summarizeReport({});
  assert.equal(summary.verdict, undefined);
  assert.equal(summary.issue_count, 0);
  assert.deepEqual(summary.by_severity, {});
  assert.deepEqual(summary.issues, []);
});
