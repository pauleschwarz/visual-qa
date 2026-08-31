import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessReview, prepareHarnessReview } from "../src/review.mjs";

function fakeReport(evidence) {
  return {
    run_id: "abc12345",
    verdict: "PASS",
    complete: true,
    coverage: { states: 1, actions: 1, limit_reason: null },
    issues: [],
    phases: {},
    evidence,
  };
}

const PAIR = (id, status = "observed") => ({
  action_id: id,
  observation: { status, pixel_ratio: 0.5 },
  before: { screenshot: `/tmp/${id}-before.png` },
  after: { screenshot: `/tmp/${id}-after.png` },
});

// Realistic flow: run/explore wrote report.json first; prepare only adds
// vision/requests.json. Tests mirror that by persisting the report first.
async function persistReport(dir, report) {
  await writeFile(join(dir, "report.json"), JSON.stringify(report));
  return report;
}

test("prepare exports pairs x skill requests with prompts and ids", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-hprep-`);
  const report = fakeReport([PAIR("state1:button:Save::0"), PAIR("state2:link:Home::1")]);
  const { file, requests } = await prepareHarnessReview(report, dir, { maxPairs: 2 });
  // 2 pairs x 4 skills
  assert.equal(requests, 8);
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.run_id, "abc12345");
  assert.match(written.contract, /review-apply/);
  const skills = new Set(written.requests.map((r) => r.skill));
  assert.deepEqual([...skills].sort(), ["consistency", "layout", "readability", "slop"]);
  for (const request of written.requests) {
    assert.ok(request.id.startsWith("abc12345-"));
    assert.match(request.system, /visual QA reviewer/);
    assert.ok(request.before.endsWith("-before.png"));
  }
});

test("apply caps severity, records request ids, and is idempotent", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-happly-`);
  const report = fakeReport([PAIR("state1:button:Save::0")]);
  await persistReport(dir, report);
  await prepareHarnessReview(report, dir, { maxPairs: 1 });
  const findingsFile = join(dir, "findings.json");
  await writeFile(
    findingsFile,
    JSON.stringify({
      results: [
        {
          id: "abc12345-layout-state1-button-save-0",
          skill: "layout",
          action_id: "state1:button:Save::0",
          findings: [
            { title: "Clipped button", severity: "high", detail: "overflow" },
            { title: "bad shape", severity: "nope", detail: "x" },
          ],
        },
        {
          id: "abc12345-slop-state1-button-save-0",
          skill: "slop",
          findings: [],
        },
        { id: "", findings: [] },
      ],
    }),
  );
  const first = await applyHarnessReview(dir, findingsFile);
  // The high finding arrives capped at medium: vision can add, never gate.
  const applied = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  assert.equal(first.accepted, 1);
  assert.equal(applied.issues.length, 1);
  assert.equal(applied.issues[0].severity, "medium");
  assert.equal(applied.issues[0].evidence.source, "harness-vision");
  assert.equal(applied.verdict, "UNPROVEN");
  // Re-apply is a no-op, not a duplicate: both answered ids count as
  // already_applied, the empty id as missing_id.
  const second = await applyHarnessReview(dir, findingsFile);
  assert.equal(second.accepted, 0);
  assert.equal(second.rejected, 3);
  const afterReapply = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  assert.equal(afterReapply.issues.length, 1);
});

test("apply rejects malformed findings files loudly", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-hbad-`);
  const report = fakeReport([PAIR("a")]);
  await persistReport(dir, report);
  await prepareHarnessReview(report, dir, { maxPairs: 1 });
  const bad = join(dir, "bad.json");
  await writeFile(bad, JSON.stringify({ results: "nope" }));
  await assert.rejects(() => applyHarnessReview(dir, bad), /results/);
});

test("apply recomputes the verdict against stored completeness", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-hverd-`);
  const report = fakeReport([PAIR("a")]);
  report.complete = false;
  await persistReport(dir, report);
  await prepareHarnessReview(report, dir, { maxPairs: 1 });
  const findingsFile = join(dir, "f.json");
  await writeFile(
    findingsFile,
    JSON.stringify({
      results: [
        { id: "abc12345-layout-a", findings: [{ title: "x", severity: "low", detail: "y" }] },
      ],
    }),
  );
  await applyHarnessReview(dir, findingsFile);
  const applied = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  // incomplete coverage can never be upgraded by findings
  assert.equal(applied.verdict, "COVERAGE_INCOMPLETE");
});
