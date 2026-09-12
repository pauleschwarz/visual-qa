import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateAgentGate, writeAgentGate } from "../src/agent-gate.mjs";

function visual({ verdict = "PASS", complete = true } = {}) {
  return {
    schema_version: "vqa-0.1",
    product: "Visual QA",
    run_id: "qa-run",
    started_at: "2026-09-12T12:00:00.000Z",
    duration_ms: 100,
    verdict,
    complete,
    coverage: {
      limit_reason: complete ? null : "max_runtime_ms",
      vision_complete: complete,
    },
  };
}

function verity({ verdict = "PASS", stale = false } = {}) {
  return {
    schema_version: 3,
    created_at: "2026-09-12T12:01:00.000Z",
    verdict,
    repository_changed_since_baseline: stale,
    final_diff_hash: "sha256:bound",
  };
}

test("agent gate accepts a complete visual PASS bound to a fresh Verity PASS", () => {
  const result = evaluateAgentGate({ visual: visual(), verity: verity() });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("agent gate requires explicit completed vision evidence", () => {
  const report = visual();
  delete report.coverage.vision_complete;
  const result = evaluateAgentGate({ visual: report, verity: verity() });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("visual_qa_vision_incomplete"));
});

test("agent gate requires an explicit fresh Verity receipt", () => {
  for (const stale of [undefined, null, "false", true]) {
    const receipt = verity();
    receipt.repository_changed_since_baseline = stale;
    const result = evaluateAgentGate({ visual: visual(), verity: receipt });
    assert.equal(result.ok, false, `must block ${String(stale)}`);
    assert.ok(result.blockers.includes("verity_receipt_stale"));
  }
});

test("agent gate rejects invalid visual durations", () => {
  for (const duration of [-1, "100", null]) {
    const report = visual();
    report.duration_ms = duration;
    const result = evaluateAgentGate({ visual: report, verity: verity() });
    assert.equal(result.ok, false, `must block ${String(duration)}`);
    assert.ok(result.blockers.includes("visual_qa_invalid_duration_ms"));
  }
});

test("agent gate rejects contradictory PASS reports with unresolved issues", () => {
  const report = visual();
  report.issues = [{ severity: "high", title: "Still broken" }];
  const result = evaluateAgentGate({ visual: report, verity: verity() });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("visual_qa_unresolved_issues"));
});

test("agent gate sends Verity warnings to human review instead of auto-passing", () => {
  const result = evaluateAgentGate({
    visual: visual(),
    verity: verity({ verdict: "PASS_WITH_WARNINGS" }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("verity_verdict_PASS_WITH_WARNINGS"));
});

test("agent gate rejects a Verity receipt older than its visual evidence", () => {
  const receipt = verity();
  receipt.created_at = "2026-09-12T11:59:00.000Z";
  const result = evaluateAgentGate({ visual: visual(), verity: receipt });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("verity_predates_visual_qa"));
});

test("agent gate fails closed for incomplete visual evidence", () => {
  const result = evaluateAgentGate({ visual: visual({ complete: false }), verity: verity() });
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("visual_qa_incomplete"));
});

test("agent gate fails closed when either evidence source is non-passing or stale", () => {
  for (const input of [
    { visual: visual({ verdict: "FAIL" }), verity: verity(), blocker: "visual_qa_verdict_FAIL" },
    { visual: visual(), verity: verity({ verdict: "UNPROVEN" }), blocker: "verity_verdict_UNPROVEN" },
    { visual: visual(), verity: verity({ stale: true }), blocker: "verity_receipt_stale" },
  ]) {
    const result = evaluateAgentGate(input);
    assert.equal(result.ok, false);
    assert.ok(result.blockers.includes(input.blocker));
  }
});

test("agent gate persists a portable machine-readable receipt", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-agent-gate-`);
  const result = await writeAgentGate(dir, { visual: visual(), verity: verity() });
  const saved = JSON.parse(await readFile(join(dir, "agent-gate.json"), "utf8"));
  assert.equal(result.path, join(dir, "agent-gate.json"));
  assert.equal(saved.verdict, "PASS");
  assert.equal(saved.evidence.visual_qa.verdict, "PASS");
  assert.equal(saved.evidence.verity.verdict, "PASS");
});

test("agent gate rejects malformed evidence instead of assuming a pass", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-agent-gate-invalid-`);
  const visualFile = join(dir, "report.json");
  const verityFile = join(dir, "verity.json");
  await writeFile(visualFile, JSON.stringify(visual()));
  await writeFile(verityFile, "not json");
  await assert.rejects(
    () => writeAgentGate(dir, { visualFile, verityFile }),
    /Invalid Verity receipt JSON/,
  );
});
