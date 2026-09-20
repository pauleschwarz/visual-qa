import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyHarnessReview,
  evaluateVisionCoverage,
  prepareHarnessReview,
} from "../src/review.mjs";
import { SKILLS, skillPrompt } from "../src/vision.mjs";

const SKILL_COUNT = Object.keys(SKILLS).length;

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

async function persistReport(dir, report) {
  await writeFile(join(dir, "report.json"), JSON.stringify(report));
  return report;
}

async function allCleanAnswers(dir) {
  const planned = JSON.parse(
    await readFile(join(dir, "vision", "requests.json"), "utf8"),
  );
  return {
    results: planned.requests.map((r) => ({
      id: r.id,
      skill: r.skill,
      findings: [],
    })),
  };
}

test("prepare exports pairs x skill requests with prompts and ids", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-hprep-`);
  const report = fakeReport([
    PAIR("state1:button:Save::0"),
    PAIR("state2:link:Home::1"),
  ]);
  const prepared = await prepareHarnessReview(report, dir, {
    maxPairs: 2,
    batchSize: 4,
    skills: "all",
  });
  assert.equal(prepared.dir, join(dir, "vision"));
  assert.equal(prepared.requests, 2 * SKILL_COUNT);
  assert.equal(prepared.batches, Math.ceil((2 * SKILL_COUNT) / 4));
  const written = JSON.parse(await readFile(prepared.file, "utf8"));
  assert.equal(written.run_id, "abc12345");
  assert.match(written.contract, /subagent|review-apply/i);
  const skills = new Set(written.requests.map((r) => r.skill));
  assert.ok(skills.has("preservation"));
  assert.deepEqual(
    [...skills].sort(),
    Object.keys(SKILLS).sort(),
  );
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
    skills: "all",
    maxStatePairs: 50,
  });
  assert.equal(
    requests,
    3 * SKILL_COUNT,
    "2 states + 1 action, each across all skills",
  );
  const written = JSON.parse(await readFile(file, "utf8"));
  const stateRequests = written.requests.filter(
    (request) => request.context.kind === "state_scan",
  );
  assert.equal(stateRequests.length, 2 * SKILL_COUNT);
});

test("prepare injects DESIGN.md contract into every request system prompt", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-hprep-design-`);
  const contract = {
    path: "/tmp/DESIGN.md",
    sha256: "abc",
    content: "# Brand\nPrimary: #112233\n",
    source: "explicit",
  };
  const report = fakeReport([PAIR("only")]);
  report.design_contract = {
    path: contract.path,
    sha256: contract.sha256,
    source: contract.source,
  };
  const { file } = await prepareHarnessReview(report, dir, {
    maxPairs: 1,
    designContract: contract,
    skills: "all",
    maxStatePairs: 50,
  });
  const written = JSON.parse(await readFile(file, "utf8"));
  for (const request of written.requests) {
    assert.match(request.system, /DESIGN\.md BEGIN/);
    assert.match(request.system, /Primary: #112233/);
    assert.equal(request.context.design_contract_sha256, "abc");
  }
  assert.match(skillPrompt("preservation", { designContract: contract }), /preserve/i);
});

test("apply is fail-closed until every planned id has a valid answer", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-happly-partial-`);
  const report = fakeReport([PAIR("state1:button:Save::0")]);
  await persistReport(dir, report);
  await prepareHarnessReview(report, dir, { maxPairs: 1 ,
    skills: "all",
    maxStatePairs: 50,
  });
  const planned = JSON.parse(
    await readFile(join(dir, "vision", "requests.json"), "utf8"),
  );
  const one = planned.requests[0];
  const findingsFile = join(dir, "findings.json");
  await writeFile(
    findingsFile,
    JSON.stringify({
      results: [{ id: one.id, skill: one.skill, findings: [] }],
    }),
  );
  const partial = await applyHarnessReview(dir, findingsFile);
  assert.equal(partial.vision_complete, false);
  assert.equal(partial.verdict, "COVERAGE_INCOMPLETE");
  assert.ok(partial.missing.length > 0);
  assert.equal(partial.ok, false);
  const applied = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  assert.equal(applied.coverage.vision_complete, false);
  assert.ok(
    applied.issues.some((i) => i.issue_id === "vqa-vision-review-incomplete"),
  );
  assert.deepEqual(applied.coverage.vision_requests.answered, [one.id]);
});

test("apply completes only when all planned ids answered exactly once", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-happly-full-`);
  const report = fakeReport([PAIR("state1:button:Save::0")]);
  await persistReport(dir, report);
  await prepareHarnessReview(report, dir, { maxPairs: 1 ,
    skills: "all",
    maxStatePairs: 50,
  });
  const findingsFile = join(dir, "findings-full.json");
  await writeFile(findingsFile, JSON.stringify(await allCleanAnswers(dir)));
  const full = await applyHarnessReview(dir, findingsFile);
  assert.equal(full.vision_complete, true);
  assert.equal(full.ok, true);
  assert.equal(full.missing.length, 0);
  const applied = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  assert.equal(applied.coverage.vision_complete, true);
  assert.ok(
    !applied.issues.some((i) => i.issue_id === "vqa-vision-required-unavailable"),
  );
  assert.ok(
    !applied.issues.some((i) => i.issue_id === "vqa-vision-review-incomplete"),
  );
});

test("apply rejects unknown, duplicate, malformed, and skill-mismatch ids", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-happly-bad-`);
  const report = fakeReport([PAIR("state1:button:Save::0")]);
  await persistReport(dir, report);
  await prepareHarnessReview(report, dir, { maxPairs: 1 ,
    skills: "all",
    maxStatePairs: 50,
  });
  const planned = JSON.parse(
    await readFile(join(dir, "vision", "requests.json"), "utf8"),
  );
  const first = planned.requests[0];
  const second = planned.requests[1];
  const findingsFile = join(dir, "findings-bad.json");
  await writeFile(
    findingsFile,
    JSON.stringify({
      results: [
        { id: "totally-unknown", skill: "layout", findings: [] },
        {
          id: first.id,
          skill: first.skill,
          findings: [
            { title: "Clipped", severity: "high", detail: "overflow" },
          ],
        },
        { id: first.id, skill: first.skill, findings: [] },
        { id: second.id, skill: "not-a-skill", findings: [] },
        {
          id: planned.requests[2].id,
          skill: planned.requests[2].skill,
          findings: [{ title: "x", severity: "nope", detail: "y" }],
        },
        { id: "", findings: [] },
        { id: planned.requests[3].id, skill: planned.requests[3].skill },
      ],
    }),
  );
  const result = await applyHarnessReview(dir, findingsFile);
  assert.equal(result.vision_complete, false);
  assert.equal(result.verdict, "COVERAGE_INCOMPLETE");
  const reasons = new Set(result.invalid.map((e) => e.reason));
  assert.ok(reasons.has("unknown_id"));
  assert.ok(reasons.has("duplicate_id"));
  assert.ok(reasons.has("unknown_skill") || reasons.has("skill_mismatch"));
  assert.ok(reasons.has("invalid_finding"));
  assert.ok(reasons.has("missing_id"));
  assert.ok(reasons.has("malformed_findings"));
  // first id still counted as answered (valid once)
  assert.ok(result.answered.includes(first.id));
  assert.ok(result.missing.length > 0);
});

test("evaluateVisionCoverage unit: one-of-many is incomplete", () => {
  const required = ["a", "b", "c"];
  const plannedById = new Map(
    required.map((id) => [id, { id, skill: "layout" }]),
  );
  const coverage = evaluateVisionCoverage({
    requiredIds: required,
    plannedById,
    results: [{ id: "a", skill: "layout", findings: [] }],
  });
  assert.equal(coverage.vision_complete, false);
  assert.deepEqual(coverage.missing, ["b", "c"]);
  assert.deepEqual(coverage.answered, ["a"]);
});

test("apply caps severity and is idempotent once complete", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-happly-idem-`);
  const report = fakeReport([PAIR("state1:button:Save::0")]);
  await persistReport(dir, report);
  await prepareHarnessReview(report, dir, { maxPairs: 1 ,
    skills: "all",
    maxStatePairs: 50,
  });
  const planned = JSON.parse(
    await readFile(join(dir, "vision", "requests.json"), "utf8"),
  );
  const answers = {
    results: planned.requests.map((r, index) =>
      index === 0
        ? {
            id: r.id,
            skill: r.skill,
            findings: [
              { title: "Clipped button", severity: "high", detail: "overflow" },
            ],
          }
        : { id: r.id, skill: r.skill, findings: [] },
    ),
  };
  const findingsFile = join(dir, "findings.json");
  await writeFile(findingsFile, JSON.stringify(answers));
  const first = await applyHarnessReview(dir, findingsFile);
  assert.equal(first.vision_complete, true);
  assert.equal(first.accepted, 1);
  const applied = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  assert.equal(applied.issues[0].severity, "medium");
  const second = await applyHarnessReview(dir, findingsFile);
  assert.equal(second.vision_complete, true);
  const again = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  assert.equal(
    again.issues.filter((i) => i.title === "Clipped button").length,
    1,
  );
});

test("prepare loop pack caps state pairs and uses all six critics", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-hprep-loop-`);
  const evidence = [];
  for (let i = 0; i < 8; i++) {
    evidence.push({
      kind: "state_scan",
      state_id: `s${i}`,
      viewport: "mobile",
      screenshot: `screenshots/state-${i}.png`,
    });
  }
  evidence.push(PAIR("action-a"), PAIR("action-b"), PAIR("action-c"));
  const report = fakeReport(evidence);
  const prepared = await prepareHarnessReview(report, dir, {
    maxPairs: 2,
    maxStatePairs: 3,
    batchSize: 6,
    skills: "loop",
  });
  // 3 states + 2 actions = 5 pairs × 6 loop skills
  assert.equal(prepared.requests, 5 * 6);
  assert.ok(prepared.batches <= 5, `batches ${prepared.batches} should stay small`);
  const written = JSON.parse(await readFile(prepared.file, "utf8"));
  assert.equal(
    new Set(written.requests.map((request) => request.id)).size,
    written.requests.length,
    "every request id must remain unique when state ids share a truncated slug",
  );
  const skills = new Set(written.requests.map((r) => r.skill));
  assert.deepEqual([...skills].sort(), [
    "color",
    "consistency",
    "layout",
    "preservation",
    "readability",
    "slop",
  ]);
});
