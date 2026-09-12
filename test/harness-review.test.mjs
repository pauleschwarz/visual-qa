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
    coverage: {
      states: 1,
      actions: 1,
      limit_reason: null,
      vision_required: true,
      vision_complete: false,
    },
    issues: [
      {
        issue_id: "vqa-vision-required-unavailable",
        type: "vqa-vision",
        title: "Vision review unavailable",
        severity: "high",
        detail: "gap",
      },
    ],
    phases: {},
    evidence,
  };
}

const PAIR = (id, status = "observed") => ({
  action_id: id,
  observation: { status, pixel_ratio: 0.5 },
  before: { screenshot: `screenshots/${id}-before.png` },
  after: { screenshot: `screenshots/${id}-after.png` },
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
  const prepared = await prepareHarnessReview(report, dir, {
    maxPairs: 2,
    batchSize: 4,
  });
  // 2 pairs x 5 skills
  assert.equal(prepared.dir, join(dir, "vision"));
  assert.equal(prepared.requests, 10);
  assert.equal(prepared.batches, 3); // ceil(10/4)
  const written = JSON.parse(await readFile(prepared.file, "utf8"));
  assert.equal(written.run_id, "abc12345");
  assert.match(written.contract, /subagent|review-apply/i);
  assert.equal(written.batch_count, 3);
  const skills = new Set(written.requests.map((r) => r.skill));
  assert.deepEqual([...skills].sort(), ["color", "consistency", "layout", "readability", "slop"]);
  for (const request of written.requests) {
    assert.ok(request.id.startsWith("abc12345-"));
    assert.match(request.system, /visual QA reviewer/);
    assert.ok(request.before.endsWith("-before.png"));
    assert.ok(
      !request.before.startsWith("/") && !/^[A-Za-z]:\\/.test(request.before),
      "request paths stay portable (no absolute host paths)",
    );
    assert.match(request.before, /^screenshots\//);
  }
  const plan = JSON.parse(await readFile(join(dir, "vision", "plan.json"), "utf8"));
  assert.equal(plan.mode, "harness-subagent");
  assert.equal(plan.batch_count, 3);
  assert.ok(plan.apply_command.includes("review-apply"));
  const batch1 = JSON.parse(
    await readFile(join(dir, "vision", "batches", "batch-01.json"), "utf8"),
  );
  assert.equal(batch1.requests.length, 4);
  assert.ok(batch1.requests[0].before_abs.endsWith(batch1.requests[0].before));
  assert.match(batch1.contract, /harsh direct-observer/i);
  const planMd = await readFile(join(dir, "vision", "plan.md"), "utf8");
  assert.match(planMd, /spawn one short-lived subagent/i);
});

test("prepare includes every state scan plus bounded action pairs", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-hprep-states-`);
  const report = fakeReport([
    PAIR("action-one"),
    PAIR("action-two"),
    {
      kind: "state_scan",
      state_id: "home@abc",
      viewport: "mobile",
      screenshot: "screenshots/state-home.png",
    },
    {
      kind: "state_scan",
      state_id: "settings@def",
      viewport: "desktop",
      screenshot: "screenshots/state-settings.png",
    },
  ]);
  const { file, requests } = await prepareHarnessReview(report, dir, {
    maxPairs: 1,
  });
  assert.equal(requests, 15, "2 states + 1 action, each across 5 skills");
  const written = JSON.parse(await readFile(file, "utf8"));
  const stateRequests = written.requests.filter(
    (request) => request.context.kind === "state_scan",
  );
  assert.equal(stateRequests.length, 10);
  assert.ok(stateRequests.every((request) => request.before === request.after));
  assert.deepEqual(
    [...new Set(stateRequests.map((request) => request.state_id))].sort(),
    ["home@abc", "settings@def"],
  );
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
  // empty findings are valid; only missing/invalid ids keep ok=false
  assert.equal(first.ok, false, "missing_id / invalid_finding keep apply non-ok");
  assert.ok(first.rejected > 0);
  assert.equal(first.vision_complete, true);
  assert.equal(applied.coverage.vision_complete, true);
  assert.equal(applied.issues.length, 1);
  assert.ok(!applied.issues.some((i) => i.issue_id === "vqa-vision-required-unavailable"));
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
  report.coverage.limit_reason = "max_states";
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
  const result = await applyHarnessReview(dir, findingsFile);
  const applied = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  // Walk bounds still incomplete; vision can complete independently.
  assert.equal(applied.verdict, "COVERAGE_INCOMPLETE");
  assert.equal(applied.complete, false);
  assert.equal(applied.coverage.vision_complete, true);
  assert.equal(result.vision_complete, true);
  assert.ok(
    !applied.issues.some((i) => i.issue_id === "vqa-vision-required-unavailable"),
  );
});

test("apply closes vision when walk finished and harness answers land", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-hclose-`);
  const report = fakeReport([PAIR("a")]);
  report.complete = false; // only blocked by vision gap
  report.coverage.limit_reason = null;
  report.coverage.vision_complete = false;
  await persistReport(dir, report);
  await prepareHarnessReview(report, dir, { maxPairs: 1 });
  const findingsFile = join(dir, "f.json");
  await writeFile(
    findingsFile,
    JSON.stringify({
      results: [
        { id: "abc12345-layout-a", skill: "layout", findings: [] },
        { id: "abc12345-slop-a", skill: "slop", findings: [] },
      ],
    }),
  );
  const result = await applyHarnessReview(dir, findingsFile);
  const applied = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  assert.equal(result.vision_complete, true);
  assert.equal(applied.coverage.vision_complete, true);
  assert.equal(applied.complete, true);
  assert.equal(applied.verdict, "PASS");
  assert.ok(
    !applied.issues.some((i) => i.issue_id === "vqa-vision-required-unavailable"),
  );
});
