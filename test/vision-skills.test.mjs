import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { runVisionReview } from "../src/vision.mjs";

function pngFile(dir, name) {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200;
    png.data[i + 1] = 30;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  const file = join(dir, name);
  // PNG.sync.write returns a Buffer; the vision module reads via fs.
  return import("node:fs/promises").then((fs) =>
    fs.writeFile(file, PNG.sync.write(png)).then(() => file),
  );
}

function fakeReport(before, after) {
  return {
    evidence: [
      {
        action_id: "state1:button:Save::0",
        observation: { status: "error" },
        before: { screenshot: before },
        after: { screenshot: after },
      },
    ],
  };
}

const FINDINGS_RESPONSE = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          findings: [
            { title: "Clipped button", severity: "high", detail: "overflow" },
          ],
        }),
      },
    },
  ],
};

test("vision review dispatches one call per skill and caps severity", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-vision-`);
  const before = await pngFile(dir, "before.png");
  const after = await pngFile(dir, "after.png");
  const outDir = await mkdtemp(`${tmpdir()}/vqa-vision-out-`);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => FINDINGS_RESPONSE };
  };
  process.env.VQA_VISION_API_KEY = "test-key";
  try {
    const result = await runVisionReview({
      report: fakeReport(before, after),
      config: { bounds: { max_agent_calls: 4 }, outDir },
      fetchImpl,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.attempted, 4);
    assert.equal(result.completed, 4);
    assert.equal(calls.length, 4);
    // Four distinct skills were dispatched by the deterministic orchestrator.
    const skills = new Set(
      result.issues.map((issue) => issue.evidence.skill),
    );
    assert.equal(skills.size, 4);
    // Additive-only contract: a "high" model finding arrives capped at medium.
    assert.equal(result.issues[0].severity, "medium");
    assert.equal(result.issues[0].type, "vqa-vision");
    // Traceability: every call leaves its raw response and findings on disk.
    const traced = await readdir(join(outDir, "vision"));
    assert.equal(traced.filter((f) => f.endsWith(".response.json")).length, 4);
    assert.equal(traced.filter((f) => f.endsWith(".findings.json")).length, 4);
    const finding = JSON.parse(
      await readFile(join(outDir, "vision", traced[0]), "utf8"),
    );
    assert.ok("skill" in finding || finding.findings !== undefined);
  } finally {
    delete process.env.VQA_VISION_API_KEY;
  }
});

test("vision review stays skipped without budget or key", async () => {
  const skipped = await runVisionReview({
    report: fakeReport("/x.png", "/y.png"),
    config: { bounds: { max_agent_calls: 0 } },
  });
  assert.equal(skipped.status, "skipped_no_calls");
  process.env.VQA_VISION_API_KEY = "test-key";
  try {
    const noCalls = await runVisionReview({
      report: fakeReport("/x.png", "/y.png"),
      config: { bounds: { max_agent_calls: 2 } },
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(noCalls.status, "error");
    assert.deepEqual(noCalls.issues, []);
  } finally {
    delete process.env.VQA_VISION_API_KEY;
  }
});
