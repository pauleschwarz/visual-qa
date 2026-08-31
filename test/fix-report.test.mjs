import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyFixes,
  collectFixes,
  diffIssues,
} from "../src/fix.mjs";
import { renderMarkdownReport } from "../src/report.mjs";

test("collectFixes maps only whitelisted axe rules to fix kinds", () => {
  const issues = [
    { evidence: { rule: "document-title" } },
    { evidence: { rule: "html-has-lang" } },
    { evidence: { rule: "color-contrast" } },
    { evidence: {} },
    {},
  ];
  assert.deepEqual(collectFixes(issues), [
    { kind: "title" },
    { kind: "lang" },
  ]);
  assert.deepEqual(collectFixes([]), []);
});

test("applyFixes inserts title and lang into static html", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-fix-`);
  const file = join(dir, "index.html");
  await writeFile(
    file,
    "<!doctype html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body><p>hi</p></body></html>\n",
  );
  const { applied, skipped } = await applyFixes(
    [{ kind: "title" }, { kind: "lang" }],
    dir,
  );
  assert.equal(applied.length, 2);
  assert.deepEqual(skipped, []);
  const html = await readFile(file, "utf8");
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<html lang="en">/);
  assert.ok(html.includes("<title>") === true);
});

test("applyFixes skips already-correct documents and unwritable dirs", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-fix-`);
  const file = join(dir, "index.html");
  await writeFile(
    file,
    '<!doctype html>\n<html lang="de"><head><meta charset="utf-8"><title>Meine App</title></head></html>',
  );
  const { applied } = await applyFixes(
    [{ kind: "title" }, { kind: "lang" }],
    dir,
  );
  assert.equal(applied.length, 0);
  const missing = await applyFixes([{ kind: "title" }], join(dir, "nope"));
  assert.equal(missing.applied.length, 0);
  assert.deepEqual(missing.skipped, ["title"]);
});

test("diffIssues computes fixed set by issue_id", () => {
  const before = [
    { issue_id: "a" },
    { issue_id: "b" },
  ];
  const after = [{ issue_id: "b" }, { issue_id: "c" }];
  const diff = diffIssues(before, after);
  assert.deepEqual(
    diff.fixed.map((i) => i.issue_id),
    ["a"],
  );
  assert.equal(diff.remaining.length, 2);
});

test("markdown report renders verdict, phases, and grouped issues", () => {
  const report = {
    verdict: "FAIL",
    duration_ms: 1500,
    coverage: {
      states: 3,
      actions: 7,
      limit_reason: null,
      viewports_covered: ["mobile", "desktop"],
    },
    phases: {
      vision: { status: "skipped_no_endpoint", issues: 0 },
      fix: { applied: [{ kind: "title", file: "index.html" }], skipped: [] },
      verify: { verdict: "PASS", complete: true, fixed: 2, remaining: 1 },
    },
    issues: [
      {
        type: "vqa-runtime",
        severity: "critical",
        title: "Unhandled page error",
        detail: "boom at window.onload",
      },
      {
        type: "vqa-slop",
        severity: "low",
        title: "Placeholder copy left in the UI",
        detail: "TODO found",
      },
    ],
  };
  const md = renderMarkdownReport(report);
  assert.match(md, /\*\*Verdict:\*\* `FAIL`/);
  assert.match(md, /## Phases/);
  assert.match(md, /vision: `skipped_no_endpoint`/);
  assert.match(md, /### CRITICAL/);
  assert.match(md, /### LOW/);
  assert.match(md, /Unhandled page error/);
});

test("markdown report states explicitly when no issues exist", () => {
  const md = renderMarkdownReport({
    verdict: "PASS",
    coverage: { states: 1, actions: 2, viewports_covered: ["mobile"] },
    issues: [],
  });
  assert.match(md, /## Issues/);
  assert.match(md, /None\./);
});
