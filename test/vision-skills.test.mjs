import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
  discoverVisionModels,
  looksMultimodalModel,
  resolveVisionTransport,
  runVisionReview,
  skillPrompt,
  SKILLS,
} from "../src/vision.mjs";

function pngFile(dir, name) {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200;
    png.data[i + 1] = 30;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  const file = join(dir, name);
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
      {
        kind: "state_scan",
        state_id: "home",
        screenshot: after,
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

test("vision skill prompts demand harsh direct-observer slop critique", () => {
  assert.deepEqual(Object.keys(SKILLS).sort(), [
    "color",
    "consistency",
    "layout",
    "readability",
    "slop",
  ]);
  const slop = skillPrompt("slop");
  assert.match(slop, /harsh direct-observer/i);
  assert.match(slop, /purple|mesh|glassmorphism|supercharge|feature cards/i);
  assert.match(skillPrompt("layout"), /dead empty bands|sticky/i);
  assert.match(skillPrompt("consistency"), /spacing that jumps|font families/i);
  assert.match(skillPrompt("color"), /multi-accent|contrast|neon/i);
});

test("resolveVisionTransport prefers VQA then OPENAI/OmniRoute env", () => {
  const t = resolveVisionTransport({
    OPENAI_API_KEY: "from-openai",
    OPENAI_BASE_URL: "http://127.0.0.1:20128/v1/",
    VQA_VISION_MODELS: "smart, worker",
  });
  assert.equal(t.endpoint, "http://127.0.0.1:20128/v1");
  assert.equal(t.key, "from-openai");
  assert.deepEqual(t.models, ["smart", "worker"]);
  assert.equal(t.source.endpoint, "OPENAI_BASE_URL");
  assert.equal(t.source.key, "OPENAI_API_KEY");
  assert.equal(looksMultimodalModel("smart"), true);
  assert.equal(looksMultimodalModel("text-embedding-3-small"), false);
});

test("discoverVisionModels filters multimodal ids from /models", async () => {
  const models = await discoverVisionModels({
    endpoint: "http://vision.test/v1",
    key: "k",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "text-embedding-3-small" },
          { id: "smart" },
          { id: "worker" },
          { id: "gpt-4o-mini" },
        ],
      }),
    }),
  });
  assert.deepEqual(models, ["smart", "worker", "gpt-4o-mini"]);
});

test("vision review dispatches across skills and models, caps severity", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-vision-`);
  const before = await pngFile(dir, "before.png");
  const after = await pngFile(dir, "after.png");
  const outDir = await mkdtemp(`${tmpdir()}/vqa-vision-out-`);
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith("/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "smart" }, { id: "worker" }] }),
      };
    }
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...FINDINGS_RESPONSE,
        model: options ? JSON.parse(options.body).model : "smart",
      }),
    };
  };

  const previous = {
    key: process.env.VQA_VISION_API_KEY,
    endpoint: process.env.VQA_VISION_ENDPOINT,
    models: process.env.VQA_VISION_MODELS,
    disable: process.env.VQA_VISION_DISABLE,
    openaiKey: process.env.OPENAI_API_KEY,
    openaiBase: process.env.OPENAI_BASE_URL,
  };
  process.env.VQA_VISION_API_KEY = "test-key";
  process.env.VQA_VISION_ENDPOINT = "https://vision.test/v1";
  delete process.env.VQA_VISION_MODELS;
  delete process.env.VQA_VISION_DISABLE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;

  try {
    const result = await runVisionReview({
      report: fakeReport(before, after),
      config: { bounds: { max_agent_calls: 5 }, outDir },
      fetchImpl,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.completed, 5);
    assert.equal(calls.length, 5);
    assert.ok(result.models.includes("smart"));
    assert.ok(result.models.includes("worker"));
    // Round-robin models across jobs.
    const used = calls.map((c) => c.body.model);
    assert.ok(used.includes("smart") && used.includes("worker"));
    // First jobs are state_scan × skills; skill order starts at layout.
    const firstSkillText = calls[0].body.messages[0].content;
    assert.match(firstSkillText, /Broken layout|layout/i);
    const skillHits = calls.map((c) => c.body.messages[0].content);
    assert.ok(skillHits.some((t) => /Color system/.test(t)));
    assert.ok(result.issues.every((i) => i.severity === "medium" || i.severity === "low"));
    assert.ok(result.issues.some((i) => i.title === "Clipped button"));
  } finally {
    for (const [k, v] of Object.entries({
      VQA_VISION_API_KEY: previous.key,
      VQA_VISION_ENDPOINT: previous.endpoint,
      VQA_VISION_MODELS: previous.models,
      VQA_VISION_DISABLE: previous.disable,
      OPENAI_API_KEY: previous.openaiKey,
      OPENAI_BASE_URL: previous.openaiBase,
    })) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("vision review stays skipped without budget or key", async () => {
  const previous = {
    key: process.env.VQA_VISION_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    omni: process.env.OMNIROUTE_API_KEY,
    disable: process.env.VQA_VISION_DISABLE,
  };
  delete process.env.VQA_VISION_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.VQA_VISION_DISABLE;
  try {
    // No key + zero budget → no auto-arm.
    const noCalls = await runVisionReview({
      report: { evidence: [] },
      config: { bounds: { max_agent_calls: 0 } },
    });
    assert.equal(noCalls.status, "skipped_no_calls");

    // Key present + empty evidence → auto/explicit budget still needs pairs.
    process.env.VQA_VISION_API_KEY = "k";
    const noPairs = await runVisionReview({
      report: { evidence: [] },
      config: { bounds: { max_agent_calls: 4 }, outDir: await mkdtemp(`${tmpdir()}/vqa-np-`) },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/models"))
          return { ok: true, json: async () => ({ data: [{ id: "smart" }] }) };
        throw new Error("should not call completions without pairs");
      },
    });
    assert.equal(noPairs.status, "skipped_no_pairs");
  } finally {
    for (const [k, v] of Object.entries({
      VQA_VISION_API_KEY: previous.key,
      OPENAI_API_KEY: previous.openai,
      OMNIROUTE_API_KEY: previous.omni,
      VQA_VISION_DISABLE: previous.disable,
    })) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("armed review without screenshot pairs reports skipped_no_pairs", async () => {
  const previousKey = process.env.VQA_VISION_API_KEY;
  process.env.VQA_VISION_API_KEY = "k";
  try {
    const result = await runVisionReview({
      report: { evidence: [{ action_id: "x" }] },
      config: { bounds: { max_agent_calls: 2 }, outDir: await mkdtemp(`${tmpdir()}/vqa-np2-`) },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/models"))
          return { ok: true, json: async () => ({ data: [{ id: "gpt-4o-mini" }] }) };
        throw new Error("no completions");
      },
    });
    assert.equal(result.status, "skipped_no_pairs");
  } finally {
    if (previousKey == null) delete process.env.VQA_VISION_API_KEY;
    else process.env.VQA_VISION_API_KEY = previousKey;
  }
});
