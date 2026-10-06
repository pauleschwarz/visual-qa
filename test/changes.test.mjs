import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  collectGitState,
  importerIndex,
  importSpecifiers,
  resolveDiffBase,
  resolveRoutesFromMap,
} from "../src/changes.mjs";
import { agentRun, parseVisualQaYaml, resolveChangedRoutes } from "../src/agent-run.mjs";

const CLI = resolve(import.meta.dirname, "..", "bin", "visual-qa.mjs");

function sh(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function put(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

/** A throw-away repo on `main` with one commit of `files`. */
function repo(files = { "src/App.tsx": "export const a = 1;\n", "README.md": "x\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "vqa-changes-"));
  sh(dir, "init", "-q", "-b", "main");
  put(dir, files);
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const commit = (dir, message = "change") => {
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", message);
};

test("change set: commits since the branch point, staged, unstaged and untracked are all in", () => {
  const dir = repo({ "a.ts": "1\n", "b.ts": "1\n", "c.ts": "1\n", "d.ts": "1\n" });
  sh(dir, "checkout", "-qb", "feature");
  put(dir, { "a.ts": "2\n" });
  commit(dir);
  put(dir, { "b.ts": "2\n" });
  sh(dir, "add", "b.ts");
  put(dir, { "c.ts": "2\n", "new.tsx": "export {};\n", ".gitignore": "ignored.tsx\n", "ignored.tsx": "x\n" });
  const state = collectGitState(dir);
  assert.deepEqual(state.committed_files, ["a.ts"]);
  assert.deepEqual(state.untracked_files, [".gitignore", "new.tsx"]);
  assert.deepEqual(state.changed_files.sort(), [".gitignore", "a.ts", "b.ts", "c.ts", "new.tsx"]);
  assert.ok(!state.changed_files.includes("d.ts"));
  assert.ok(!state.changed_files.includes("ignored.tsx"));
  assert.equal(state.base_ref, "main");
});

test("change set: a branch without commits and a clean tree have nothing to check", () => {
  const dir = repo();
  sh(dir, "checkout", "-qb", "feature");
  assert.deepEqual(collectGitState(dir).changed_files, []);
});

test("change set: only an untracked file is a change, and it moves the diff hash", () => {
  const dir = repo();
  const before = collectGitState(dir);
  put(dir, { "src/New.tsx": "export {};\n" });
  const after = collectGitState(dir);
  assert.deepEqual(after.changed_files, ["src/New.tsx"]);
  assert.notEqual(after.diff_sha256, before.diff_sha256);
  put(dir, { "src/New.tsx": "export const x = 1;\n" });
  assert.notEqual(collectGitState(dir).diff_sha256, after.diff_sha256);
});

test("change set: a rename lists both paths, a deleted file stays listed", () => {
  const dir = repo({ "src/Old.tsx": "export const old = 'a long enough body to be a rename';\n", "src/Gone.tsx": "g\n" });
  sh(dir, "checkout", "-qb", "feature");
  sh(dir, "mv", "src/Old.tsx", "src/Renamed.tsx");
  sh(dir, "rm", "-q", "src/Gone.tsx");
  const state = collectGitState(dir);
  assert.deepEqual(state.renamed_files, [{ from: "src/Old.tsx", to: "src/Renamed.tsx" }]);
  assert.deepEqual(state.deleted_files.sort(), ["src/Gone.tsx", "src/Old.tsx"]);
  assert.deepEqual(state.changed_files.sort(), ["src/Gone.tsx", "src/Old.tsx", "src/Renamed.tsx"]);
});

test("change set: the tool's own output folder is not a change; paths with spaces and umlauts survive", () => {
  const dir = repo();
  put(dir, { ".qa-agent/report.json": "{}", "src/Größe Karte.tsx": "export {};\n" });
  const state = collectGitState(dir, { exclude: [".qa-agent"] });
  assert.deepEqual(state.changed_files, ["src/Größe Karte.tsx"]);
  assert.deepEqual(collectGitState(dir).changed_files.sort(), [".qa-agent/report.json", "src/Größe Karte.tsx"]);
});

test("change set: inside a sub-folder of the repository, paths are relative to it", () => {
  const dir = repo({ "web/src/A.tsx": "1\n", "api/x.ts": "1\n" });
  put(dir, { "web/src/A.tsx": "2\n", "api/x.ts": "2\n", "web/src/B.tsx": "1\n" });
  assert.deepEqual(collectGitState(join(dir, "web")).changed_files.sort(), ["src/A.tsx", "src/B.tsx"]);
});

test("base: origin/HEAD wins over a local main that moved ahead", () => {
  const origin = repo();
  const dir = mkdtempSync(join(tmpdir(), "vqa-clone-"));
  sh(dir, "clone", "-q", origin, dir);
  put(dir, { "local-main.txt": "x\n" });
  commit(dir, "local main only");
  sh(dir, "checkout", "-qb", "feature");
  put(dir, { "f.tsx": "export {};\n" });
  commit(dir);
  const state = collectGitState(dir);
  assert.equal(state.base_ref, "origin/HEAD");
  assert.deepEqual(state.committed_files.sort(), ["f.tsx", "local-main.txt"]);
  assert.deepEqual(collectGitState(dir, { base: "main" }).committed_files, ["f.tsx"]);
});

test("base: master is the last fallback, an explicit base must resolve, none at all says so", () => {
  const dir = repo();
  sh(dir, "branch", "-m", "main", "master");
  assert.equal(resolveDiffBase(dir).ref, "master");
  assert.throws(() => resolveDiffBase(dir, { base: "nope" }), /base "nope" does not resolve/);
  sh(dir, "branch", "-m", "master", "trunk");
  assert.throws(() => resolveDiffBase(dir), /no base branch found \(tried origin\/HEAD, main, master\).*--base/);
  assert.equal(resolveDiffBase(dir, { base: "trunk" }).ref, "trunk");
});

test("base: no git repository and no commits are named, not crashes", () => {
  const plain = mkdtempSync(join(tmpdir(), "vqa-plain-"));
  assert.throws(() => collectGitState(plain), /not inside a git repository/);
  const empty = mkdtempSync(join(tmpdir(), "vqa-empty-"));
  sh(empty, "init", "-q", "-b", "main");
  assert.throws(() => collectGitState(empty), /no commits yet/);
});

test("route_map_mode: all matches by default, first only on request", () => {
  const map = { "src/Nav*": ["/nav"], "src/**": ["/a", "/b"] };
  const all = resolveRoutesFromMap(["src/Nav.tsx"], map);
  assert.deepEqual(all.routes.sort(), ["/a", "/b", "/nav"]);
  const first = resolveRoutesFromMap(["src/Nav.tsx"], map, { mode: "first" });
  assert.deepEqual(first.routes, ["/nav"]);
});

test("reasons: each route names the file and the pattern that brought it", () => {
  const result = resolveRoutesFromMap(["src/Nav.tsx"], { "src/Nav*": ["/nav"], "lib/**": ["/lib"] });
  assert.deepEqual(result.route_reasons, { "/nav": [{ file: "src/Nav.tsx", pattern: "src/Nav*" }] });
});

test("GLOBAL is FULL: one global file walks the whole app, and is named", () => {
  const cfg = parseVisualQaYaml('route_map:\n  "src/styles/**": GLOBAL\n  "src/**": ["/a"]\n');
  assert.equal(cfg.route_map["src/styles/**"], "FULL");
  const result = resolveRoutesFromMap(["src/styles/tokens.css", "src/A.tsx"], cfg.route_map);
  assert.equal(result.mode, "full");
  assert.deepEqual(result.full_reasons, [{ file: "src/styles/tokens.css", pattern: "src/styles/**" }]);
  const narrow = resolveRoutesFromMap(["src/A.tsx"], cfg.route_map);
  assert.equal(narrow.mode, "changed");
});

test("GLOBAL and FULL given straight to the resolver walk the whole app", () => {
  for (const word of ["GLOBAL", "FULL", "global"])
    assert.equal(resolveRoutesFromMap(["src/A.tsx"], { "src/**": word }).mode, "full", word);
});

test("IMPORTERS: files that import each other are counted once", () => {
  const files = {
    "src/a.tsx": "import './b';\n",
    "src/b.tsx": "import './a';\nimport './page';\n",
    "src/page.tsx": "import './a';\n",
  };
  const result = resolveRoutesFromMap(
    ["src/a.tsx"],
    { "src/page.tsx": ["/page"], "src/a.tsx": "IMPORTERS", "src/b.tsx": "IMPORTERS" },
    { importersOf: importerIndex(Object.keys(files), (file) => files[file]), depth: 6 },
  );
  assert.deepEqual(result.routes, ["/page"]);
  assert.equal(result.route_reasons["/page"].length, 1);
});

test("unmatched files: tolerated while another file resolves, listed, and fail-closed alone", () => {
  const map = { "src/**": ["/a"] };
  const some = resolveRoutesFromMap(["src/A.tsx", "lib/x.ts"], map);
  assert.equal(some.mode, "changed");
  assert.deepEqual(some.unmapped, ["lib/x.ts"]);
  const none = resolveRoutesFromMap(["lib/x.ts"], map);
  assert.equal(none.mode, null);
  assert.equal(none.reason, "no_matching_route_map");
});

const PROJECT = {
  "src/components/Button.tsx": "export const Button = () => null;\n",
  "src/components/Card.tsx": "import { Button } from './Button';\nexport const Card = () => Button;\n",
  "src/components/Card.test.tsx": "import { Card } from './Card';\n",
  "src/pages/Home.tsx": "import { Card } from '@/components/Card';\nexport const Home = () => Card;\n",
  "src/pages/Pricing.tsx": "import { Button } from '../components/Button';\n",
  "src/components/Orphan.tsx": "export const Orphan = () => null;\n",
  "src/lib/format.ts": "export const f = 1;\n",
  "scripts/tool.mjs": "import { f } from '../src/lib/format.ts';\n",
};
const MAP = {
  "src/pages/Home.tsx": ["/"],
  "src/pages/Pricing.tsx": ["/pricing"],
  "src/components/**": "IMPORTERS",
  "src/lib/**": "IMPORTERS",
};

function importersFor(aliases = { "@": "src" }) {
  return importerIndex(Object.keys(PROJECT), (file) => PROJECT[file], aliases);
}

test("IMPORTERS: a changed component reaches the routes of the pages that use it, through intermediates", () => {
  const result = resolveRoutesFromMap(["src/components/Button.tsx"], MAP, {
    importersOf: importersFor(),
    ignore: ["**/*.test.tsx"],
  });
  assert.equal(result.mode, "changed");
  assert.deepEqual(result.routes.sort(), ["/", "/pricing"]);
  assert.deepEqual(result.route_reasons["/"], [
    {
      file: "src/components/Button.tsx",
      pattern: "src/pages/Home.tsx",
      via: ["src/components/Card.tsx", "src/pages/Home.tsx"],
    },
  ]);
  assert.deepEqual(result.route_reasons["/pricing"][0].via, ["src/pages/Pricing.tsx"]);
});

test("IMPORTERS: depth caps the climb", () => {
  const shallow = resolveRoutesFromMap(["src/components/Button.tsx"], MAP, {
    importersOf: importersFor(),
    depth: 1,
  });
  assert.deepEqual(shallow.routes, ["/pricing"]);
});

test("IMPORTERS: the alias from the config is what finds @/components/Card", () => {
  const result = resolveRoutesFromMap(["src/components/Card.tsx"], MAP, {
    importersOf: importersFor({}),
  });
  assert.equal(result.mode, null);
  assert.equal(result.reason, "no_matching_route_map");
  const withAlias = resolveRoutesFromMap(["src/components/Card.tsx"], MAP, { importersOf: importersFor() });
  assert.deepEqual(withAlias.routes, ["/"]);
});

test("IMPORTERS: imported by nothing is unrendered (a PASS with a name), not a failure", () => {
  const result = resolveRoutesFromMap(["src/components/Orphan.tsx"], MAP, { importersOf: importersFor() });
  assert.equal(result.mode, "unrendered");
  assert.deepEqual(result.unrendered, ["src/components/Orphan.tsx"]);
});

test("IMPORTERS: importers that no route_map entry reaches fail closed instead of passing silently", () => {
  const result = resolveRoutesFromMap(["src/lib/format.ts"], MAP, { importersOf: importersFor() });
  assert.equal(result.mode, null);
  assert.equal(result.reason, "no_matching_route_map");
  assert.deepEqual(result.unmapped, ["src/lib/format.ts"]);
});

test("importers: ignore globs drop test files from the climb", () => {
  const withTests = resolveRoutesFromMap(["src/components/Card.tsx"], { ...MAP, "src/**/*.test.tsx": ["/tests"] }, {
    importersOf: importersFor(),
  });
  assert.ok(withTests.routes.includes("/tests"));
  const ignored = resolveRoutesFromMap(["src/components/Card.tsx"], { ...MAP, "src/**/*.test.tsx": ["/tests"] }, {
    importersOf: importersFor(),
    ignore: ["**/*.test.tsx"],
  });
  assert.ok(!ignored.routes.includes("/tests"));
});

test("importSpecifiers: runtime imports count, type-only imports and packages do not resolve to project files", () => {
  const specs = importSpecifiers(
    [
      "import a from './a';",
      "import type { T } from './types';",
      "export { b } from './b';",
      "import './side-effect.css';",
      "const c = await import('./c');",
      "const d = require('./d');",
      "@import './theme.css';",
      "@use './tokens';",
    ].join("\n"),
  );
  assert.deepEqual(specs, ["./a", "./b", "./side-effect.css", "./theme.css", "./c", "./d", "./tokens"]);
  const index = importerIndex(
    ["src/x/index.ts", "src/y.ts", "src/z.ts"],
    (file) => ({ "src/y.ts": "import './x';\nimport 'react';", "src/z.ts": "import './y.js?raw';" })[file],
  );
  assert.deepEqual(index("src/x/index.ts"), ["src/y.ts"]);
  assert.deepEqual(index("src/y.ts"), ["src/z.ts"]);
});

test("config: the new keys parse, an old config keeps its defaults and no warnings", () => {
  const cfg = parseVisualQaYaml(
    [
      "base: origin/dev",
      "route_map_mode: first",
      "import_depth: 5",
      "aliases:",
      '  "@": src',
      "server:",
      "  command: npm run dev -- --port 5175",
      "  health: http://127.0.0.1:5175/",
      "  startup_timeout_ms: 20000",
      "route_map:",
      '  "src/**": IMPORTERS',
    ].join("\n"),
  );
  assert.equal(cfg.base, "origin/dev");
  assert.equal(cfg.route_map_mode, "first");
  assert.equal(cfg.import_depth, 5);
  assert.deepEqual(cfg.aliases, { "@": "src" });
  assert.deepEqual(cfg.server, {
    command: "npm run dev -- --port 5175",
    health: "http://127.0.0.1:5175/",
    startup_timeout_ms: 20000,
  });
  assert.equal(cfg.route_map["src/**"], "IMPORTERS");
  assert.deepEqual(cfg.warnings, []);

  const old = parseVisualQaYaml('trigger:\n  - "src/**"\nroute_map:\n  "src/**": FULL\n');
  assert.equal(old.base, null);
  assert.equal(old.route_map_mode, "all");
  assert.equal(old.server, null);
  assert.deepEqual(old.aliases, {});
  assert.deepEqual(old.warnings, []);
});

test("config: a half server block and bad values stop or warn", () => {
  assert.throws(() => parseVisualQaYaml("server:\n  command: npm run dev\n"), /server needs both command and health/);
  assert.throws(
    () => parseVisualQaYaml("server:\n  command: x\n  health: http://h/\n  startup_timeout_ms: soon\n"),
    /startup_timeout_ms must be a positive integer/,
  );
  assert.throws(() => parseVisualQaYaml("server: npm run dev\n"), /server must be an indented block/);
  const cfg = parseVisualQaYaml("route_map_mode: some\nimport_depth: 0\n");
  assert.equal(cfg.route_map_mode, "all");
  assert.equal(cfg.import_depth, 3);
  assert.equal(cfg.warnings.length, 2);
});

function cli(cwd, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
}

test("agent-run: back to the base, the route is gone again (Gegenweg), nothing reaches a browser", () => {
  const dir = repo({
    "src/pages/Home.tsx": "export const Home = 1;\n",
    ".visual-qa.yml": 'trigger:\n  - "src/**"\n  - "out/**"\nroute_map:\n  "src/pages/**":\n    - /\n',
  });
  sh(dir, "checkout", "-qb", "feature");
  put(dir, { "src/pages/Home.tsx": "export const Home = 2;\n" });
  assert.deepEqual(
    resolveRoutesFromMap(collectGitState(dir).changed_files, parseVisualQaYaml('route_map:\n  "src/pages/**":\n    - /\n').route_map)
      .routes,
    ["/"],
  );
  sh(dir, "checkout", "--", "src/pages/Home.tsx");
  const state = collectGitState(dir);
  assert.deepEqual(state.changed_files, []);
  const run = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no UI diff → PASS \(noop\)/);
  // The first run left out/*.json in the tree; the trigger below would pick them up if they were not excluded.
  const again = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /no UI diff → PASS \(noop\)/);
});

test("agent-run: outside git, without a base and with a half server block it stops with exit 2 and a sentence", () => {
  const plain = mkdtempSync(join(tmpdir(), "vqa-plain-"));
  const outside = cli(plain, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(plain, "out"));
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /not inside a git repository/);

  const dir = repo();
  sh(dir, "branch", "-m", "main", "trunk");
  const noBase = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.equal(noBase.status, 2);
  assert.match(noBase.stderr, /no base branch found/);
  const wrong = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--base", "nope", "--out", join(dir, "out"));
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /base "nope" does not resolve/);
  const viaGitRef = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--git-ref", "trunk", "--out", join(dir, "out"));
  assert.equal(viaGitRef.status, 0, viaGitRef.stderr);

  put(dir, { ".visual-qa.yml": "base: trunk\nserver:\n  command: npm run dev\n" });
  const half = cli(dir, "agent-run", "--out", join(dir, "out"));
  assert.equal(half.status, 2);
  assert.match(half.stderr, /server needs both command and health/);
});

test("agent-run: a base from the config is used, --base beats it", () => {
  const dir = repo({ "src/pages/Home.tsx": "export const Home = 1;\n" });
  sh(dir, "branch", "-m", "main", "trunk");
  put(dir, { ".visual-qa.yml": "base: trunk\nroute_map:\n  \"src/pages/**\":\n    - /\n" });
  const fromConfig = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.equal(fromConfig.status, 0, fromConfig.stderr);
  const wrong = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--base", "nope", "--out", join(dir, "out"));
  assert.equal(wrong.status, 2);
});

test("agent-run: a changed file that nothing imports is a named noop, one no route reaches fails", () => {
  const dir = repo({ "src/pages/Home.tsx": "export const Home = 1;\n" });
  put(dir, {
    ".visual-qa.yml": 'route_map:\n  "src/pages/**":\n    - /\n  "src/components/**": IMPORTERS\n',
    "src/components/Orphan.tsx": "export const Orphan = 1;\n",
  });
  const orphan = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.equal(orphan.status, 0, orphan.stderr);
  assert.match(orphan.stdout, /imported by nothing \(src\/components\/Orphan\.tsx\)/);

  put(dir, { "src/lib/x.ts": "export const x = 1;\n" });
  const unmapped = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out2"));
  assert.equal(unmapped.status, 1);
});

test("config keys reach the resolver: mode, depth, ignore and aliases decide the routes", () => {
  const dir = repo({
    "src/Button.tsx": "export const Button = 1;\n",
    "src/Card.tsx": "import { Button } from './Button';\n",
    "src/Card.test.tsx": "import { Button } from './Button';\n",
    "src/pages/Home.tsx": "import { Card } from '@/Card';\n",
  });
  const yaml = (extra) =>
    parseVisualQaYaml(
      [
        extra,
        "route_map:",
        '  "src/Button.tsx": IMPORTERS',
        '  "src/Card.tsx": IMPORTERS',
        '  "src/*.test.tsx":',
        "    - /tests",
        '  "src/pages/**":',
        "    - /",
        '  "src/**":',
        "    - /any",
      ].join("\n"),
    );
  const routes = (extra) => resolveChangedRoutes(["src/Button.tsx"], yaml(extra), dir).routes.sort();
  assert.deepEqual(routes('aliases:\n  "@": src\n'), ["/", "/any", "/tests"]);
  assert.deepEqual(routes('route_map_mode: first\naliases:\n  "@": src\n'), ["/", "/tests"], "only the first entry per file counts, so /any is gone");
  assert.deepEqual(routes('import_depth: 1\naliases:\n  "@": src\n'), ["/any", "/tests"], "depth 1 never reaches the page");
  assert.deepEqual(routes('ignore:\n  - "src/*.test.tsx"\naliases:\n  "@": src\n'), ["/", "/any"]);
  assert.ok(!routes("").includes("/"), "no alias, the page is not found");
});

test("agentRun: gitRef is the older name of base", async () => {
  const dir = repo();
  sh(dir, "branch", "-m", "main", "trunk");
  const result = await agentRun({ url: "http://127.0.0.1:1", outDir: join(dir, "out"), projectRoot: dir, gitRef: "trunk" });
  assert.equal(result.noop, true);
  assert.equal(result.agent.git.ref, "trunk");
});
