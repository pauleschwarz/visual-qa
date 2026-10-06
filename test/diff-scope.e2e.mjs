import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { agentRun } from "../src/agent-run.mjs";

const FIXTURE = resolve(import.meta.dirname, "..", "fixture", "server.mjs");

function freePort() {
  return new Promise((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

test("agent-run: a commit on the branch reaches its route through an importer; the app server runs only during the walk", async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "vqa-scope-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  mkdirSync(join(dir, "src", "pages"), { recursive: true });
  writeFileSync(join(dir, "src", "components", "Nav.tsx"), "export const Nav = 1;\n");
  writeFileSync(join(dir, "src", "pages", "Home.tsx"), "import { Nav } from '@/components/Nav';\n");
  writeFileSync(
    join(dir, ".visual-qa.yml"),
    [
      "aliases:",
      '  "@": src',
      "route_map:",
      '  "src/pages/**":',
      "    - /",
      '  "src/components/**": IMPORTERS',
      "server:",
      `  command: PORT=${port} node ${JSON.stringify(FIXTURE)}`,
      `  health: http://127.0.0.1:${port}/`,
      "",
    ].join("\n"),
  );
  git("add", ".");
  git("commit", "-qm", "init");
  git("checkout", "-qb", "feature");
  writeFileSync(join(dir, "src", "components", "Nav.tsx"), "export const Nav = 2;\n");
  git("add", ".");
  git("commit", "-qm", "change nav");

  process.env.VQA_VISION_DISABLE = "1";
  try {
    const result = await agentRun({
      outDir: join(dir, "out"),
      projectRoot: dir,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: { max_runtime_ms: 120_000 },
    });
    assert.equal(result.agent.mode, "changed");
    assert.deepEqual(result.agent.routes, ["/"]);
    assert.deepEqual(result.agent.git.committed_files, ["src/components/Nav.tsx"]);
    assert.deepEqual(result.agent.route_reasons["/"], [
      { file: "src/components/Nav.tsx", pattern: "src/pages/**", via: ["src/pages/Home.tsx"] },
    ]);
    assert.ok(result.report.states.length > 0, "the route was walked in a browser");
  } finally {
    delete process.env.VQA_VISION_DISABLE;
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }), "the app server is stopped");
});
