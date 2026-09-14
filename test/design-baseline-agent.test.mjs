import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
  filterChangedUiFiles,
  matchGlob,
  parseVisualQaYaml,
  resolveRoutesFromMap,
} from "../src/agent-run.mjs";
import { evaluateAgentGate } from "../src/agent-gate.mjs";
import {
  resolveBaselinePath,
  routeKeyFromTarget,
} from "../src/baseline.mjs";
import {
  appendDesignContractToPrompt,
  resolveDesignContract,
  sha256Hex,
} from "../src/design-contract.mjs";
import { skillPrompt, SKILLS } from "../src/vision.mjs";

function tinyPng(path, shade = 0) {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = shade;
    png.data[i + 1] = shade;
    png.data[i + 2] = shade;
    png.data[i + 3] = 255;
  }
  return writeFile(path, PNG.sync.write(png));
}

test("DESIGN.md resolve: explicit missing fails; discovery optional", async () => {
  const root = await mkdtemp(`${tmpdir()}/vqa-design-`);
  await assert.rejects(
    () =>
      resolveDesignContract({
        explicitPath: join(root, "missing-DESIGN.md"),
        projectRoot: root,
      }),
    /unreadable|design-contract/i,
  );
  assert.equal(
    await resolveDesignContract({ projectRoot: root }),
    null,
  );
  const designPath = join(root, "DESIGN.md");
  await writeFile(designPath, "# Hello\nradius: 8\n");
  const discovered = await resolveDesignContract({ projectRoot: root });
  assert.equal(discovered.source, "discovered");
  assert.equal(discovered.sha256, sha256Hex("# Hello\nradius: 8\n"));
  const explicit = await resolveDesignContract({
    explicitPath: designPath,
    projectRoot: root,
  });
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.sha256, discovered.sha256);
});

test("skillPrompt includes design contract and preservation skill exists", () => {
  assert.ok(SKILLS.preservation);
  const contract = {
    path: "/x/DESIGN.md",
    sha256: "deadbeef",
    content: "Use Inter only.",
  };
  const prompt = skillPrompt("layout", { designContract: contract });
  assert.match(prompt, /Authoritative DESIGN\.md/);
  assert.match(prompt, /Use Inter only/);
  assert.match(skillPrompt("preservation"), /Preservation critic/i);
  assert.equal(
    appendDesignContractToPrompt("base", null),
    "base",
  );
});

test("baseline hierarchical lookup with legacy flat fallback", async () => {
  const root = await mkdtemp(`${tmpdir()}/vqa-base-`);
  const hier = join(root, "settings");
  await mkdir(hier, { recursive: true });
  await tinyPng(join(hier, "desktop.png"), 10);
  await tinyPng(join(root, "mobile.png"), 20);

  const hit = await resolveBaselinePath(root, "desktop", {
    routeKey: "settings",
  });
  assert.equal(hit.missing, false);
  assert.equal(hit.shape, "hierarchical");
  assert.ok(hit.path.endsWith(`${join("settings", "desktop.png")}`) || hit.path.includes("settings"));

  const legacy = await resolveBaselinePath(root, "mobile", {
    routeKey: "settings",
  });
  assert.equal(legacy.missing, false);
  assert.equal(legacy.shape, "legacy_flat");

  const missing = await resolveBaselinePath(root, "tablet", {
    routeKey: "settings",
  });
  assert.equal(missing.missing, true);

  assert.equal(routeKeyFromTarget("/settings/profile", "http://x/"), "settings-profile");
  assert.equal(routeKeyFromTarget("/", "http://x/"), "root");
});

test("parse .visual-qa.yml and route mapping", () => {
  const cfg = parseVisualQaYaml(`
trigger:
  - "src/components/**"
  - "app/**/*.tsx"
ignore:
  - "**/*.test.tsx"
route_map:
  "src/components/Nav*":
    - /nav
    - /header
  "app/settings/**":
    - /settings
  "app/pages/**": FULL
`);
  assert.deepEqual(cfg.trigger, ["src/components/**", "app/**/*.tsx"]);
  assert.ok(cfg.ignore.includes("**/*.test.tsx"));
  assert.deepEqual(cfg.route_map["src/components/Nav*"], ["/nav", "/header"]);
  assert.equal(cfg.route_map["app/pages/**"], "FULL");

  assert.ok(matchGlob("src/components/**", "src/components/Nav.tsx"));
  assert.ok(!matchGlob("src/components/*", "src/components/a/b.tsx"));

  const ui = filterChangedUiFiles(
    [
      "src/components/Nav.tsx",
      "README.md",
      "src/components/Nav.test.tsx",
      "lib/util.ts",
    ],
    cfg,
  );
  assert.deepEqual(ui, ["src/components/Nav.tsx"]);

  const routes = resolveRoutesFromMap(ui, cfg.route_map);
  assert.equal(routes.mode, "changed");
  assert.deepEqual(routes.routes.sort(), ["/header", "/nav"]);

  const full = resolveRoutesFromMap(
    ["app/pages/home.tsx"],
    cfg.route_map,
  );
  assert.equal(full.mode, "full");

  const none = resolveRoutesFromMap(["src/components/Nav.tsx"], {});
  assert.equal(none.mode, null);
  assert.equal(none.reason, "no_route_map");

  const policy = parseVisualQaYaml(`max_review_fix_loops: 2
trigger:
  - "src/**/*.tsx"
`);
  assert.equal(policy.max_review_fix_loops, 2);
});

test("agent-gate records max 2 review/fix loops and refuses a fixer-applied agent-run", () => {
  const visual = {
    schema_version: "vqa-0.1",
    run_id: "r1",
    started_at: "2026-09-12T12:00:00.000Z",
    duration_ms: 100,
    verdict: "PASS",
    complete: true,
    coverage: { vision_complete: true },
    agent_run: {
      git: {
        head: "abc",
        ref: "HEAD",
        diff_sha256: createHash("sha256").update("d").digest("hex"),
      },
      policy: { max_review_fix_loops: 2, applies_fixers: false },
      review_fix_loops: 0,
      fixer_applied: false,
    },
  };
  const verity = {
    schema_version: 3,
    created_at: "2026-09-12T12:01:00.000Z",
    verdict: "PASS",
    repository_changed_since_baseline: false,
    final_diff_hash: "sha256:x",
  };
  assert.equal(evaluateAgentGate({ visual, verity }).ok, true);

  const fixer = {
    ...visual,
    agent_run: { ...visual.agent_run, fixer_applied: true },
  };
  const fixerGate = evaluateAgentGate({ visual: fixer, verity });
  assert.equal(fixerGate.ok, false);
  assert.ok(fixerGate.blockers.includes("visual_qa_agent_ran_fixer"));

  const over = {
    ...visual,
    agent_run: { ...visual.agent_run, review_fix_loops: 3 },
  };
  const overGate = evaluateAgentGate({ visual: over, verity });
  assert.equal(overGate.ok, false);
  assert.ok(overGate.blockers.includes("visual_qa_review_fix_loops_exceeded"));
});

test("agent-gate requires git+design when agent_run present; direct runs OK", () => {
  const visual = {
    schema_version: "vqa-0.1",
    run_id: "r1",
    started_at: "2026-09-12T12:00:00.000Z",
    duration_ms: 100,
    verdict: "PASS",
    complete: true,
    coverage: { vision_complete: true },
  };
  const verity = {
    schema_version: 3,
    created_at: "2026-09-12T12:01:00.000Z",
    verdict: "PASS",
    repository_changed_since_baseline: false,
    final_diff_hash: "sha256:x",
  };
  assert.equal(evaluateAgentGate({ visual, verity }).ok, true);

  const withAgent = {
    ...visual,
    agent_run: {
      git: {
        head: "abc",
        ref: "HEAD",
        diff_sha256: createHash("sha256").update("d").digest("hex"),
      },
    },
    design_contract: { path: "/p/DESIGN.md", sha256: "aa".repeat(32) },
  };
  assert.equal(evaluateAgentGate({ visual: withAgent, verity }).ok, true);

  const missingGit = {
    ...visual,
    agent_run: { git: { head: "", ref: "HEAD", diff_sha256: "x" } },
  };
  const bad = evaluateAgentGate({ visual: missingGit, verity });
  assert.equal(bad.ok, false);
  assert.ok(bad.blockers.includes("visual_qa_agent_git_head_missing"));

  const incompleteReview = {
    ...withAgent,
    coverage: {
      vision_complete: false,
      vision_requests: { missing: ["id-1"] },
    },
  };
  const inc = evaluateAgentGate({ visual: incompleteReview, verity });
  assert.equal(inc.ok, false);
  assert.ok(inc.blockers.includes("visual_qa_vision_incomplete"));
});
