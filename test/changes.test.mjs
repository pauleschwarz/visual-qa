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

// ── Nachbesserung: Kommentare, Einstiege, Tiefe, und die Klauseln, die zuvor kein Test hielt ──

test("importSpecifiers: a comment inside an import is no reason to miss it, a commented-out import is none", () => {
  const specs = importSpecifiers(
    [
      "import {",
      "  A, // the big one",
      "  /* x */ B,",
      '} from "./list";',
      '// import dead from "./line-dead";',
      '/* import dead from "./block-dead"; */',
      'const lazy = () => import(/* webpackChunkName: "x" */ "./lazy");',
      'const url = "http://example.com/a"; import "./after-url";',
      "const glob = `src/*/x`; import './after-template'; /* import './dead' */",
      'import { Größe } from "./unicode";',
      "export * as ns from './ns';",
      "@import url(./plain.css) screen;",
    ].join("\n"),
  );
  assert.deepEqual(specs.sort(), [
    "./after-template",
    "./after-url",
    "./lazy",
    "./list",
    "./ns",
    "./plain.css",
    "./unicode",
  ]);
});

test("IMPORTERS: a page importing the changed card with a comment in the import list is found (no silent noop)", () => {
  const dir = repo({
    "src/components/Card.tsx": "export const Card = 1;\nexport const Badge = 2;\n",
    "src/pages/Home.tsx": 'import {\n  Card, // the big one\n  Badge,\n} from "../components/Card";\n',
    ".visual-qa.yml": 'route_map:\n  "src/pages/**": /\n  "src/components/**": IMPORTERS\n',
  });
  put(dir, { "src/components/Card.tsx": "export const Card = 3;\nexport const Badge = 2;\n" });
  const config = parseVisualQaYaml('route_map:\n  "src/pages/**": /\n  "src/components/**": IMPORTERS\n');
  assert.deepEqual(resolveChangedRoutes(["src/components/Card.tsx"], config, dir).routes, ["/"]);
});

const ROUTES_YAML = 'route_map:\n  "src/pages/**": /\n  "src/**": IMPORTERS\n';

test("agent-run: a changed entry point that nothing imports is a PASS with a warning that says why, also next to routed files", () => {
  const dir = repo({
    "index.html": '<script type="module" src="/src/main.tsx"></script>',
    "src/main.tsx": 'import App from "./App";\n',
    "src/App.tsx": "export default () => null;\n",
    "src/pages/Home.tsx": "export const Home = 1;\n",
    ".visual-qa.yml": ROUTES_YAML,
  });
  put(dir, { "src/main.tsx": 'import App from "./App";\nimport "./theme.css";\n' });
  const alone = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.equal(alone.status, 0, alone.stderr);
  assert.match(alone.stderr, /warning: nothing imports src\/main\.tsx.*entry point/);

  put(dir, { "src/pages/Home.tsx": "export const Home = 2;\n" });
  const mixed = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out2"));
  assert.match(mixed.stderr, /warning: nothing imports src\/main\.tsx/, "dropped from a run that has other routes, still said");
  assert.match(mixed.stdout, /mode=changed routes=\//);
});

test("IMPORTERS: a climb cut off by import_depth is named, whether or not another chain reached a route", () => {
  const files = {
    "src/Leaf.tsx": "export const Leaf = 1;\n",
    "src/B.tsx": 'import { Leaf } from "./Leaf";\n',
    "src/pages/Home.tsx": 'import { B } from "../B";\n',
    "src/pages/Pricing.tsx": 'import { Leaf } from "../Leaf";\n',
  };
  const map = { "src/pages/**": ["/page"], "src/*.tsx": "IMPORTERS" };
  const importersOf = importerIndex(Object.keys(files), (file) => files[file]);
  const shallow = resolveRoutesFromMap(["src/Leaf.tsx"], map, { importersOf, depth: 1 });
  assert.deepEqual(shallow.routes, ["/page"], "Pricing is reached, Home (one level further) is not");
  assert.deepEqual(shallow.depth_exhausted, ["src/Leaf.tsx"]);
  assert.equal(shallow.import_depth, 1);
  const deep = resolveRoutesFromMap(["src/Leaf.tsx"], map, { importersOf, depth: 2 });
  assert.deepEqual(deep.depth_exhausted, []);
});

test("agent-run: a chain longer than import_depth says so by name, as warning and in the fail-closed issue", async () => {
  const dir = repo({
    "src/Leaf.tsx": "export const Leaf = 1;\n",
    "src/B.tsx": 'import { Leaf } from "./Leaf";\n',
    "src/pages/Home.tsx": 'import { B } from "../B";\n',
    ".visual-qa.yml": 'import_depth: 1\nroute_map:\n  "src/pages/**": /\n  "src/*.tsx": IMPORTERS\n',
  });
  put(dir, { "src/Leaf.tsx": "export const Leaf = 2;\n" });
  const run = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.equal(run.status, 1, run.stderr + run.stdout);
  assert.match(run.stderr, /no route_map entry reaches src\/Leaf\.tsx/);
  assert.match(run.stderr, /src\/Leaf\.tsx is imported further up than import_depth 1.*raise import_depth/);
  const result = await agentRun({ url: "http://127.0.0.1:1", outDir: join(dir, "out2"), projectRoot: dir });
  assert.match(result.report.issues[0].detail, /src\/Leaf\.tsx is longer than import_depth 1: raise import_depth/);
  put(dir, { ".visual-qa.yml": 'import_depth: 2\nroute_map:\n  "src/pages/**": /\n  "src/*.tsx": IMPORTERS\n' });
  const enough = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out3"));
  assert.doesNotMatch(enough.stderr, /import_depth/);
});

test("IMPORTERS: a hook between a component and its page needs no route_map entry of its own", () => {
  const files = {
    "src/components/Leaf.tsx": "export const L = 1;",
    "src/hooks/useLeaf.ts": 'import { L } from "../components/Leaf"; export const useLeaf = () => L;',
    "src/pages/Home.tsx": 'import { useLeaf } from "../hooks/useLeaf";',
  };
  const result = resolveRoutesFromMap(
    ["src/components/Leaf.tsx"],
    { "src/pages/**": "/", "src/components/**": "IMPORTERS" },
    { importersOf: importerIndex(Object.keys(files), (file) => files[file]) },
  );
  assert.deepEqual(result.routes, ["/"]);
  assert.deepEqual(result.route_reasons["/"][0].via, ["src/hooks/useLeaf.ts", "src/pages/Home.tsx"]);
});

test("IMPORTERS: a stylesheet chain tokens.css ← index.css (@import) ← page reaches the page's route", () => {
  const dir = repo({
    "src/styles/tokens.css": ":root{--a:1}",
    "src/styles/index.css": '@import "./tokens.css";',
    "src/pages/Home.tsx": 'import "../styles/index.css";',
  });
  const config = parseVisualQaYaml('route_map:\n  "src/pages/**": /\n  "src/styles/**": IMPORTERS\n');
  assert.deepEqual(resolveChangedRoutes(["src/styles/tokens.css"], config, dir).routes, ["/"]);
});

test("aliases: a package @scope/x is never the alias @, and the bare alias is its target's index", () => {
  const files = {
    "src/scope/x.ts": "export const x = 1;",
    "src/index.ts": "export const i = 1;",
    "src/Page.tsx": 'import { x } from "@scope/x";\nimport { i } from "@";',
  };
  const importersOf = importerIndex(Object.keys(files), (file) => files[file], { "@": "src" });
  assert.deepEqual(importersOf("src/scope/x.ts"), []);
  assert.deepEqual(importersOf("src/index.ts"), ["src/Page.tsx"]);
});

test("change set: the rename stays a rename when the user's git has diff.renames=false", () => {
  const dir = repo({ "src/Old.tsx": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n" });
  sh(dir, "switch", "-qc", "feature");
  sh(dir, "mv", "src/Old.tsx", "src/New.tsx");
  const saved = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].map((key) => process.env[key]);
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.renames", GIT_CONFIG_VALUE_0: "false" });
  try {
    const state = collectGitState(dir);
    assert.deepEqual(state.renamed_files, [{ from: "src/Old.tsx", to: "src/New.tsx" }]);
    assert.deepEqual(state.deleted_files, ["src/Old.tsx"]);
  } finally {
    ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
});

test("change set: committed_files are relative to the working folder, and never the tool's output folder", () => {
  const dir = repo({ "web/src/App.tsx": "1\n", "api/x.ts": "1\n" });
  sh(dir, "switch", "-qc", "feature");
  put(dir, { "web/src/App.tsx": "2\n", "api/x.ts": "2\n", "web/out/report.json": "{}\n" });
  commit(dir, "both");
  assert.deepEqual(collectGitState(join(dir, "web")).committed_files, ["out/report.json", "src/App.tsx"]);
  const state = collectGitState(join(dir, "web"), { exclude: ["out"] });
  assert.deepEqual(state.committed_files, ["src/App.tsx"]);
  assert.deepEqual(state.changed_files, ["src/App.tsx"]);
});

test("config: startup_timeout_ms 0 is no time, server.health needs a scheme", () => {
  assert.throws(
    () => parseVisualQaYaml("server:\n  command: x\n  health: http://h/\n  startup_timeout_ms: 0\n"),
    /startup_timeout_ms must be a positive integer/,
  );
  for (const health of ["localhost:5173/health", "ftp://h/", "http://"])
    assert.throws(
      () => parseVisualQaYaml(`server:\n  command: x\n  health: ${health}\n`),
      /server\.health must be an http\(s\) URL/,
      health,
    );
  assert.equal(parseVisualQaYaml("server:\n  command: x\n  health: HTTPS://h:1/p\n").server.health, "HTTPS://h:1/p");
});

test("agent-run: the reason lines name route, changed file, the way through, and the pattern; whole app for GLOBAL", () => {
  const dir = repo({
    "src/Leaf.tsx": "export const L = 1;\n",
    "src/pages/Home.tsx": 'import { L } from "../Leaf";\n',
    "src/styles/tokens.css": ":root{--a:1}\n",
    ".visual-qa.yml": 'route_map:\n  "src/pages/**": /\n  "src/Leaf.tsx": IMPORTERS\n  "src/styles/**": GLOBAL\n',
  });
  put(dir, { "src/Leaf.tsx": "export const L = 2;\n" });
  const routed = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.match(routed.stdout, /^ {2}\/ ← src\/Leaf\.tsx → src\/pages\/Home\.tsx \(src\/pages\/\*\*\)$/m);
  put(dir, { "src/styles/tokens.css": ":root{--a:2}\n" });
  const full = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out2"));
  assert.match(full.stdout, /^ {2}whole app ← src\/styles\/tokens\.css \(src\/styles\/\*\*\)$/m);
});

test("agent-run: a noop that left changed files out says which, so a data file or asset is not swallowed unseen", () => {
  const dir = repo({ "src/data/listing.json": "{}\n", "src/pages/Home.tsx": "export const Home = 1;\n" });
  put(dir, {
    ".visual-qa.yml": 'route_map:\n  "src/pages/**": /\n',
    "src/data/listing.json": '{"a":1}\n',
    "public/logo.svg": "<svg/>\n",
  });
  const run = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no UI diff → PASS \(noop\) — changed, not UI files .*: .*public\/logo\.svg/);
  assert.match(run.stdout, /src\/data\/listing\.json/);
  const clean = repo();
  const none = cli(clean, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(clean, "out"));
  assert.match(none.stdout, /^agent-run: no UI diff → PASS \(noop\)$/m, "nothing changed, nothing to add");
});

// ── R3: der Kommentar-Scanner, die Namensliste, die Tiefe, der Hinweis — je Klausel ein Fall und sein Gegenfall ──

const scan = (cases) => {
  for (const [name, source, want] of cases) assert.deepEqual(importSpecifiers(source).sort(), [...want].sort(), name);
};
/** A real import after the text under test, then a comment: an early-opened comment swallows the import. */
const LAZY = '\nconst L = () => import("./Lazy");\n/* end */';

test("importSpecifiers: comments — in the list, around the keyword, in a path, commented-out imports", () => {
  scan([
    ["apostrophe in a line comment inside the list", "import {\n  A, // it's the card\n  B,\n} from \"./Card\";", ["./Card"]],
    ["quote characters in a block comment", 'import {\n  A, /* "x" \'y\' `z` */\n} from "./Card";', ["./Card"]],
    ["a comment that says from \"./other\"", 'import { A, // from "./other"\n B } from "./Card";', ["./Card"]],
    ["commented-out import next to an apostrophe", '// import X from "./dead"; don\'t\nimport Y from "./live";', ["./live"]],
    ["block comment between import and from", 'import Card /* c */ from "./Card";', ["./Card"]],
    ["comment glued to the keyword", 'import/* c */Card from "./Card";', ["./Card"]],
    ["comment between from and the string", 'import Card from /* c */ "./Card";', ["./Card"]],
    ["side-effect import with a comment", 'import /* c */ "./side.css";', ["./side.css"]],
    ["export * with a comment", 'export * /* all */ from "./a";', ["./a"]],
    ["dynamic import with a webpack comment", 'const L = lazy(() => import(/* webpackChunkName: "x" */ "./Lazy"));', ["./Lazy"]],
    ["require with a comment", 'const a = require(/* c */ "./a");', ["./a"]],
    ["CRLF line comment", 'import {\r\n  A, // c\r\n} from "./Card";\r\n', ["./Card"]],
    ["a line comment on the last line, no newline after it", 'import "./live"; // import "./dead"', ["./live"]],
    ["a block comment around a whole import", '/* import "./dead"; */\nimport "./live";', ["./live"]],
    ["type-only imports stay out, also with a comment inside", 'import type {\n  A, // c\n} from "./types";\nexport type { B } from "./t2";', []],
    ["import { type A } is a runtime import", 'import { type A } from "./a";', ["./a"]],
  ]);
});

test("importSpecifiers: strings, templates and their ${…} — a comment sign inside text is no comment, a comment inside ${…} is one", () => {
  scan([
    ["// inside a double-quoted string", 'import x from "http://example.com/a.js";', ["http://example.com/a.js"]],
    ["/* inside a string", 'import x from "./a/*/b";\nimport y from "./y";', ["./a/*/b", "./y"]],
    ["single-quoted glob with /*", `const pages = import.meta.glob('./pages/*/index.tsx');${LAZY}`, ["./Lazy"]],
    ["// inside a template literal", "const u = `https://x/y`;\nimport z from './z';", ["./z"]],
    ["/* inside a template literal", "const g = `src/*/x`; import './after-template'; /* import './dead' */", ["./after-template"]],
    ["an escaped quote does not end the string", String.raw`const s = "say \"//\" ok"; import "./x"; // c`, ["./x"]],
    ["an escaped backtick does not end the template", "const t = `a\\`b`; /* import \"./dead\" */ import \"./live\";", ["./live"]],
    ["a string left open ends with its line", 'const s = \'open;\n// import dead from "./dead";\nimport live from "./live";', ["./live"]],
    ["a block comment left open is no comment", 'const a = 1; /* open\nimport "./live";', ["./live"]],
    ["a block comment left open after a closed one is no comment", 'a = 1; /* x */ b = 2; /* open\nimport "./live";', ["./live"]],
    ["/*/ does not close itself, and is no comment without a closer", 'const a = 1; /*/ import "./live";', ["./live"]],
    ["/*/ is not closed by its own star", '/*/ import "./dead" */ import "./live";', ["./live"]],
    ["a comment inside ${…} is a comment", 'const t = `${ /* import "./dead" */ 1 }`; import "./live";', ["./live"]],
    ["braces inside ${…} do not end it early", 'const t = `${ ({ a: 1 }).a /* import "./dead" */ }`; import "./live";', ["./live"]],
    ["the } that ends ${…} is not a brace of the code around", 'const t = `${ ({ a: 1 }).a }`;\n/* import "./dead" */\nimport "./live";', ["./live"]],
  ]);
});

test("importSpecifiers: a regex literal is not a comment — after an operator, bracket, `;`, a keyword or at the start; a division is none either", () => {
  const tokens = [..."(,=:[!&|?{};+-*%<>~^", "return", "typeof", "case", "do", "else", "in", "of", "void", "delete", "throw", "new", "yield", "await"];
  for (const token of tokens)
    assert.deepEqual(importSpecifiers(`x ${token} /\\/*/.test(y);${LAZY}`), ["./Lazy"], `a regex after ${token}`);
  scan([
    ["a regex at the start of the file", `/\\/*/.test(y);${LAZY}`, ["./Lazy"]],
    ["a regex with an escaped slash", `const parts = path.split(/\\//); const L = () => import("./Lazy");`, ["./Lazy"]],
    ["a / inside a regex class", `const r = /[/']/; // import "./dead"\nimport "./live";`, ["./live"]],
    ["a regex whose body holds an escaped slash", 'const r = /a\\//; // import "./dead"\nimport "./live";', ["./live"]],
    ["a class that holds a quote, then a comment", `const r = /[a']/; // import "./dead"\nimport "./live";`, ["./live"]],
    ["a regex is over after its closing slash", "const ok = /a/.test('/*');\nimport \"./live\";\n/* end */", ["./live"]],
    ["a regex with flags, then a comment", `const r = /a*/gi; /* import "./dead" */ import "./live";`, ["./live"]],
    ["a division after a word", 'const q = total / 2; const r = /* import "./dead" */ 1;\nimport "./live";', ["./live"]],
    ["a division after a number", 'const q = 4 / 2 /* import "./dead" */;\nimport "./live";', ["./live"]],
    ["a division after )", 'const q = (a + b) / 2 /* import "./dead" */;\nimport "./live";', ["./live"]],
    ["a division after ]", 'const q = list[0] / 2 /* import "./dead" */;\nimport "./live";', ["./live"]],
    ["a division after a string", 'const q = "4" / 2 /* import "./dead" */;\nimport "./live";', ["./live"]],
    ["a division after a template", 'const q = `4` / 2 /* import "./dead" */;\nimport "./live";', ["./live"]],
    ["a slash that closes nothing is a division", `const q = a /\nb; // import "./dead"\nimport "./live";`, ["./live"]],
    ["a regex does not run over the end of its line", 'const r = /abc\n// import "./dead"\nimport "./live";', ["./live"]],
    ["$ belongs to a word", 'const q = $in / 2 /* import "./dead" */;\nimport "./live";', ["./live"]],
  ]);
});

test("importSpecifiers: JSX text and tags — src/* in text is no comment, {/* … */} in it is one, a generic is no tag", () => {
  for (const token of ["=>", "(", "return", "?", ":", "&&", ","])
    assert.deepEqual(importSpecifiers(`x ${token} <code>src/*</code>;${LAZY}`), ["./Lazy"], `JSX after ${token}`);
  scan([
    ["JSX at the start of the file", `<code>src/*</code>;${LAZY}`, ["./Lazy"]],
    ["a fragment", `const a = <>src/*</>;${LAZY}`, ["./Lazy"]],
    ["a dotted tag name", `const a = <Foo.Bar>src/*</Foo.Bar>;${LAZY}`, ["./Lazy"]],
    ["a tag name with a dash", `const a = <my-element>src/*</my-element>;${LAZY}`, ["./Lazy"]],
    ["a tag name with a colon", `const a = <svg:rect>src/*</svg:rect>;${LAZY}`, ["./Lazy"]],
    ["apostrophes in the text", `import A from "./a";\nconst e = <p>Don't panic</p>;\nimport B from "./b";`, ["./a", "./b"]],
    ["text between nested elements", `const a = <ul><li>a</li> src/* <li>b</li></ul>;${LAZY}`, ["./Lazy"]],
    ["a comment after the element is a comment", `const a = <p>x</p>; /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["a self-closing element ends at once", `const a = <br />; /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["a > inside an attribute string", `const a = <a title="a>b" />; /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["an attribute string over two lines", `const a = <a title="x\ny" />; /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["an arrow inside an attribute expression", `const a = <a onClick={() => go()} />; /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["a comment in {…} between tags is a comment", `const a = <p>{/* import "./dead" */}</p>;\nimport "./live";`, ["./live"]],
    ["an import inside {…} in a tag's text", `const a = <p>{import("./inside")}</p>;`, ["./inside"]],
    ["a generic arrow is no tag", `const id = <T,>(x: T) => x; /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["a single-quoted attribute with a > inside", `const a = <a title='a>b' />; /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["a < after a word is a comparison, not a tag", `if (a <b && c > d) {} /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["a stray } at the top is no end of the file", '}\n/* import "./dead" */\nimport "./live";', ["./live"]],
    ["a < followed by a digit is no tag", `const a = <1>; /* import "./dead" */\nimport "./live";`, ["./live"]],
    ["a < that is no tag", `const lt = a < b; const c = 1 /* import "./dead" */;\nimport "./live";`, ["./live"]],
    ["a closing tag that never ends does not hang", "const a = <p>text</p", []],
  ]);
});

test("importSpecifiers: what ends a name list — each of ; ( ) = and the three quote characters", () => {
  for (const stop of [";", "(", ")", "=", '"', "'", "`"])
    assert.deepEqual(importSpecifiers(`export type { A } ${stop}\nimport B from "./b";`), ["./b"], `${stop} ends the list`);
  scan([
    ["export type {…}; then an import", 'export type { A };\nimport B from "./b";', ["./b"]],
    ["export type {…}, a call, then an import — no semicolons", 'export type { A }\nrender()\nimport B from "./b"', ["./b"]],
    ["export type X = {…}, then an import — no semicolons", 'export type X = { a: string }\nimport B from "./b"', ["./b"]],
    ["a side-effect import, then an import — no semicolons", 'import "./side.css"\nimport B from "./b"', ["./side.css", "./b"]],
    ["a long name list over lines", 'import {\n  A,\n  B as C,\n  type D,\n  default as E,\n} from "./list";', ["./list"]],
    ["default and namespace forms", 'import Def, * as ns from "./d";\nimport Def2, { x } from "./e";', ["./d", "./e"]],
    ["export * from and export {…} from", 'export * from "./a";\nexport { b } from "./b";\nexport * as c from "./c";', ["./a", "./b", "./c"]],
  ]);
});

test("importSpecifiers: stylesheets — quoted with a space, single-quoted, url() with and without quotes, @use, @forward", () => {
  scan([
    ["a double-quoted path with a space", '@use "./a b.css";', ["./a b.css"]],
    ["a single-quoted path with a space", "@forward './a b.css';", ["./a b.css"]],
    ["a single-quoted path", "@import './s.css';", ["./s.css"]],
    ["url() with double quotes", '@import url("./u.css");', ["./u.css"]],
    ["url() with single quotes and a media query", "@import url('./u2.css') screen;", ["./u2.css"]],
    ["url() without quotes", "@import url(./plain.css) screen;", ["./plain.css"]],
    ["an unquoted path ends at a space", "@use ./bare as b", ["./bare"]],
    ["url() with spaces inside the parentheses", '@import url( "./spaced.css" );', ["./spaced.css"]],
    ["@use and @forward", '@use "./partial" as p;\n@forward "./f";', ["./partial", "./f"]],
    ["a commented-out @import", '/* @import "./dead.css"; */\n@import "./live.css";', ["./live.css"]],
    ["a SCSS line comment after @use", '@use "./a" // c\n;', ["./a"]],
  ]);
});

test("importSpecifiers: a file of 100 k characters is read in well under a second", () => {
  const started = Date.now();
  importSpecifiers(`import a from "./a"; // c\nconst s = 'x'; /* c */ const r = a / 2; const e = <p>{a}</p>;\n`.repeat(1200));
  importSpecifiers("x = 1; /* \n".repeat(9000));
  assert.ok(Date.now() - started < 1000);
});

test("IMPORTERS: an importer beyond the depth that is in ignore is no reason to warn; a frontier nothing imports is none either", () => {
  const MAP = { "src/pages/**": ["/p"], "src/*.tsx": "IMPORTERS" };
  const run = (files, opts) =>
    resolveRoutesFromMap(["src/Leaf.tsx"], MAP, { importersOf: importerIndex(Object.keys(files), (f) => files[f]), ...opts });
  const beyond = { "src/Leaf.tsx": "", "src/B.tsx": 'import "./Leaf";', "src/B.test.tsx": 'import "./B";' };
  assert.deepEqual(run(beyond, { depth: 1, ignore: ["src/*.test.tsx"] }).depth_exhausted, [], "the only way on is a test file");
  assert.deepEqual(run(beyond, { depth: 1 }).depth_exhausted, ["src/Leaf.tsx"], "without ignore it is a way on");
  const dead = { "src/Leaf.tsx": "", "src/B.tsx": 'import "./Leaf";' };
  assert.deepEqual(run(dead, { depth: 1 }).depth_exhausted, [], "B is imported by nothing: the chain ended, it was not cut");
  assert.deepEqual(run(dead, { depth: 1 }).unmapped, ["src/Leaf.tsx"]);
  const cycle = { "src/Leaf.tsx": 'import "./A";', "src/A.tsx": 'import "./Leaf";' };
  assert.deepEqual(run(cycle, { depth: 1 }).depth_exhausted, [], "a cycle back to where it came from is not further up");
});

test("IMPORTERS: a file that two IMPORTERS entries match is climbed once and named once", () => {
  const files = { "src/Leaf.tsx": "", "src/B.tsx": 'import "./Leaf";', "src/pages/H.tsx": 'import "../B";', "src/Lone.tsx": "" };
  const map = { "src/pages/**": ["/p"], "src/*.tsx": "IMPORTERS", "src/L*.tsx": "IMPORTERS" };
  const importersOf = importerIndex(Object.keys(files), (f) => files[f]);
  const cut = resolveRoutesFromMap(["src/Leaf.tsx"], map, { importersOf, depth: 1 });
  assert.deepEqual(cut.depth_exhausted, ["src/Leaf.tsx"]);
  assert.deepEqual(cut.unmapped, ["src/Leaf.tsx"]);
  const alone = resolveRoutesFromMap(["src/Lone.tsx"], map, { importersOf });
  assert.deepEqual(alone.unrendered, ["src/Lone.tsx"]);
  const reached = resolveRoutesFromMap(["src/Leaf.tsx"], map, { importersOf });
  assert.deepEqual(reached.route_reasons["/p"].length, 1, "one reason, not one per entry");
});

test("agent-run: the noop note lists five changed files, and says how many more there are only past five", () => {
  const files = (n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`data/f${k}.json`, `{"v":${k}}\n`]));
  for (const [count, tail] of [[6, /, … \(6 in all\)$/], [5, /f4\.json$/]]) {
    const dir = repo({ "src/pages/Home.tsx": "export const Home = 1;\n", ".visual-qa.yml": 'route_map:\n  "src/pages/**": /\n' });
    put(dir, files(count));
    const run = cli(dir, "agent-run", "--url", "http://127.0.0.1:1", "--out", join(dir, "out"));
    const note = run.stdout.split("\n").find((line) => line.includes("changed, not UI files"));
    assert.ok(note, run.stdout + run.stderr);
    assert.match(note, tail, `${count} files`);
    assert.equal(note.includes("f4.json"), true);
    assert.equal(note.includes("f5.json"), false, "the sixth is counted, not listed");
  }
});

test("agent-run: a UI diff without any route_map fails closed with the plain sentence — no depth text, no crash", async () => {
  const dir = repo({ "src/App.tsx": "export const a = 1;\n" });
  put(dir, { "src/App.tsx": "export const a = 2;\n" });
  const result = await agentRun({ url: "http://127.0.0.1:1", outDir: join(dir, "out"), projectRoot: dir });
  assert.equal(result.ok, false);
  assert.equal(result.report.issues[0].detail, "Changed UI files require .visual-qa.yml route_map entries; fail-closed.");
  assert.deepEqual(result.agent.depth_exhausted_files, []);
});

test("config: server.health must be an http(s) URL that can be reached at all — scheme, host, port", () => {
  const health = (value) => parseVisualQaYaml(`server:\n  command: x\n  health: ${value}\n`).server.health;
  for (const bad of ["localhost:5173/health", "ftp://h/", "http://", "http://localhost:abc/", "http://localhost:99999/", "https://:5173/", "http://localhost:5173 /x", "not a url"])
    assert.throws(() => health(JSON.stringify(bad)), /server\.health must be an http\(s\) URL/, bad);
  for (const good of ["http://h", "https://h:1", "HTTPS://h:1/p", "http://[::1]:3000/", "http://localhost:5173/health?x=1", '" http://h:1/"'])
    assert.equal(health(good.startsWith('"') ? good : JSON.stringify(good)), good.startsWith('"') ? JSON.parse(good) : good, good);
});
