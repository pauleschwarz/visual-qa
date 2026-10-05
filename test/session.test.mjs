import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { parseVisualQaYaml } from "../src/agent-run.mjs";
import {
  judgeErrorState,
  parseStateSelector,
  readErrorSignals,
  resolveSessionInput,
  SetupError,
  splitStateRoutes,
  withoutExpectedFailures,
} from "../src/session.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "visual-qa.mjs");

async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), "vqa-session-"));
  for (const [name, content] of Object.entries(files))
    await writeFile(join(dir, name), content);
  return dir;
}

const rejectsSetup = (promise, pattern) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof SetupError, `not a SetupError: ${error}`);
    assert.match(error.message, pattern);
    return true;
  });

test("yaml: states, journeys, setup and quoted globs parse; unknown keys warn", () => {
  const config = parseVisualQaYaml(`
# comment
setup: ./vqa.setup.mjs
storage_state: "./auth.json"
mystery: 1
states:
  orders-error:
    path: /orders   # trailing comment
    reason: "Could not load # kept"
    expect_api:
      "**/api/orders": 500
      "http://x.test/slow": timeout
    typo_key: 1
journeys:
  checkout: ./checkout.mjs
  signup:
    file: ./signup.mjs
    fresh: true
`);
  assert.equal(config.setup, "./vqa.setup.mjs");
  assert.equal(config.storage_state, "./auth.json");
  assert.deepEqual(config.states["orders-error"].expect_api, {
    "**/api/orders": 500,
    "http://x.test/slow": "timeout",
  });
  assert.equal(config.states["orders-error"].reason, "Could not load # kept");
  assert.equal(config.states["orders-error"].path, "/orders");
  assert.equal(config.journeys.checkout, "./checkout.mjs");
  assert.deepEqual(config.journeys.signup, { file: "./signup.mjs", fresh: true });
  assert.deepEqual(config.warnings, [
    'unknown key "mystery" in .visual-qa.yml (ignored)',
    'unknown key "typo_key" in states.orders-error (ignored)',
  ]);
});

test("yaml: a file without the new keys parses exactly as before", () => {
  const config = parseVisualQaYaml(`
trigger:
- src/**/*.tsx
- "col0:with-colon/**"
ignore:
  - "**/*.test.tsx"
  - "dir:with-colon/**"
route_map:
  src/pages/**:
    - /orders
    - /
  src/App.tsx: FULL
max_review_fix_loops: 3
`);
  // (the older section parser drops a column-0 item that contains ':'; the new
  // one must not turn it into a bogus "unknown key" warning)
  assert.deepEqual(config.trigger, ["src/**/*.tsx"]);
  assert.deepEqual(config.ignore, ["**/*.test.tsx", "dir:with-colon/**"]);
  assert.deepEqual(config.route_map, {
    "src/pages/**": ["/orders", "/"],
    "src/App.tsx": "FULL",
  });
  assert.equal(config.max_review_fix_loops, 3);
  assert.equal(config.setup, null);
  assert.deepEqual(config.states, {});
  assert.deepEqual(config.journeys, {});
  assert.deepEqual(config.warnings, []);
});

test("yaml: tabs in a session section are refused with their line", () => {
  assert.throws(
    () => parseVisualQaYaml("states:\n\ta:\n\t\tpath: /x\n"),
    /line 2: tabs are not allowed/,
  );
});

test("yaml: an older config with tab-indented trigger and route_map still parses, without warnings", () => {
  const config = parseVisualQaYaml('trigger:\n\t- src/**\nroute_map:\n\t"src/**": FULL\n\t"lib/**":\n\t\t- /a\n');
  assert.deepEqual(config.trigger, ["src/**"]);
  assert.deepEqual(config.route_map, { "src/**": "FULL", "lib/**": ["/a"] });
  assert.deepEqual(config.warnings, []);
  // The refusal is for the new sections only, wherever they sit in the file.
  assert.throws(
    () => parseVisualQaYaml('trigger:\n\t- src/**\nstates:\n\ta:\n\t\tpath: /x\n'),
    /line 4: tabs are not allowed/,
  );
});

test("yaml: states or journeys written inline at the top level are refused with their line", () => {
  assert.throws(
    () => parseVisualQaYaml("setup: ./s.mjs\nstates: {orders: {path: /orders}}\n"),
    /line 2: inline/,
  );
  assert.throws(
    () => parseVisualQaYaml("journeys: checkout\n"),
    /line 1: journeys must be an indented block of named entries/,
  );
});

test("yaml: inline flow style in a session section is refused with its line", () => {
  assert.throws(
    () => parseVisualQaYaml("states:\n  a: {path: /x}\n"),
    /line 2: inline/,
  );
});

test("selectors: name or path@name; only defined states split off route_map routes", () => {
  assert.deepEqual(parseStateSelector("orders"), { name: "orders", path: null });
  assert.deepEqual(parseStateSelector("/o/42@orders"), { name: "orders", path: "/o/42" });
  assert.deepEqual(parseStateSelector("@orders"), { name: "orders", path: null });
  assert.deepEqual(
    splitStateRoutes(["/a", "/b@orders", "/@me", "@orders"], { orders: {} }),
    { plain: ["/a", "/@me"], states: ["/b@orders", "@orders"] },
  );
  // A bare word that happens to equal a state name is still a plain route.
  assert.deepEqual(splitStateRoutes(["orders"], { orders: {} }), {
    plain: ["orders"],
    states: [],
  });
});

test("setup: missing file, missing export, syntax error and bad storage_state block with a clear message", async () => {
  const dir = await project({
    "no-export.mjs": "export const x = 1;\n",
    "syntax.mjs": "export async function setup( {\n",
    "bad.json": "{nope",
  });
  const resolveWith = (config, extra = {}) =>
    resolveSessionInput(
      { states: {}, journeys: {}, ...config },
      { baseDir: dir, ...extra },
    );
  await rejectsSetup(resolveWith({ setup: "./gone.mjs" }), /setup file not found: .*gone\.mjs/);
  await rejectsSetup(resolveWith({ setup: "./no-export.mjs" }), /must export a function setup\(page, ctx\)/);
  await rejectsSetup(resolveWith({ setup: "./syntax.mjs" }), /setup file .*syntax\.mjs failed to load/);
  await rejectsSetup(resolveWith({ storage_state: "./gone.json" }), /storage_state file not found: .*gone\.json/);
  await rejectsSetup(resolveWith({ storage_state: "./bad.json" }), /storage_state file .*bad\.json is not valid JSON/);
});

test("states: unknown name, missing path, bad expect_api and unknown state setup block", async () => {
  const dir = await project({
    "setup.mjs": "export async function setup() {}\nexport async function seeded() {}\n",
  });
  const config = {
    setup: "./setup.mjs",
    states: {
      ok: { path: "/ok", setup: "seeded", expect_api: { "**/api": 500 }, reason: 7 },
      nopath: {},
      badstatus: { path: "/x", expect_api: { "**/api": 200 } },
      badsetup: { path: "/x", setup: "missing" },
    },
    journeys: {},
  };
  const resolveState = (name) =>
    resolveSessionInput(config, { baseDir: dir, states: [name] });
  await rejectsSetup(resolveState("nope"), /unknown state "nope"; known: ok, nopath/);
  await rejectsSetup(resolveState("nopath"), /state "nopath" needs a path/);
  await rejectsSetup(resolveState("badstatus"), /expect_api "\*\*\/api" must be an HTTP error status/);
  await rejectsSetup(resolveState("badsetup"), /setup "missing" is not an exported function/);
  const resolved = await resolveState("/other@ok");
  assert.deepEqual(resolved.stateDefs["/other@ok"], {
    path: "/other",
    setup: "seeded",
    fresh: false,
    reason: "7",
    expectApi: { "**/api": 500 },
  });
  // A bare value or an empty block would inject nothing and let the state pass untested.
  for (const [shape, received] of [[500, "500"], [{}, "{}"], [["**/api"], '\\["\\*\\*/api"\\]'], [null, "null"]]) {
    for (const key of ["expect_api", "fail_api"])
      await rejectsSetup(
        resolveSessionInput({ states: { a: { path: "/a", [key]: shape } } }, { baseDir: dir, states: ["a"] }),
        new RegExp(`state "a": ${key} must map a URL glob to an HTTP error status or "timeout".* received ${received}`),
      );
  }
  // fail_api is the same injection under its other name; expect_api wins on a clash.
  const alias = await resolveSessionInput(
    { states: { a: { path: "/a", fail_api: { "**/x": "timeout", "**/y": 500 }, expect_api: { "**/y": 503 } } } },
    { baseDir: dir, states: ["a"] },
  );
  assert.deepEqual(alias.stateDefs.a.expectApi, { "**/x": "timeout", "**/y": 503 });
});

test("journeys: unknown name, missing file, syntax error and missing default export block", async () => {
  const dir = await project({
    "ok.mjs": "export default async function () {}\n",
    "syntax.mjs": "export default async function ({ step }) { await step(\n",
    "named.mjs": "export async function journey() {}\n",
  });
  const config = {
    journeys: {
      ok: "./ok.mjs",
      fresh: { file: "./ok.mjs", fresh: true },
      gone: "./gone.mjs",
      syntax: "./syntax.mjs",
      named: "./named.mjs",
    },
  };
  const resolveJourney = (name) =>
    resolveSessionInput(config, { baseDir: dir, journeys: [name] });
  await rejectsSetup(resolveJourney("nope"), /unknown journey "nope"; known: ok, fresh/);
  await rejectsSetup(resolveJourney("gone"), /journey "gone": file not found/);
  await rejectsSetup(resolveJourney("syntax"), /journey "syntax" .*syntax\.mjs failed to load/);
  await rejectsSetup(resolveJourney("named"), /must export default async function \(\{ step, check \}\)/);
  const resolved = await resolveSessionInput(config, { baseDir: dir, journeys: ["ok", "fresh"] });
  assert.deepEqual(
    resolved.journeys.map(({ name, fresh }) => [name, fresh]),
    [["ok", false], ["fresh", true]],
  );
});

test("expected failures drop only the injected requests, not other 5xx", () => {
  const events = {
    network: [
      { kind: "http", url: "http://a.test/api/orders", status: 500 },
      { kind: "http", url: "http://a.test/api/other", status: 500 },
    ],
    console: [{ text: "Failed to load resource: the server responded with a status of 500" }],
    pageErrors: [{ message: "boom" }],
  };
  const filtered = withoutExpectedFailures(events, [
    { url: "http://a.test/api/orders", glob: "**/api/orders", how: 500 },
  ]);
  assert.deepEqual(filtered.network.map((item) => item.url), ["http://a.test/api/other"]);
  assert.equal(filtered.console.length, 0);
  assert.deepEqual(filtered.pageErrors, events.pageErrors);
  assert.equal(withoutExpectedFailures(events, []), events);
});

test("expected failures are matched on redacted urls: a ?token= on the injected request is no finding", async () => {
  const { redact } = await import("../src/config.mjs");
  const raw = "http://a.test/api/orders?token=abc123&page=2";
  const seenByRuntime = redact(raw);
  assert.notEqual(seenByRuntime, raw, "precondition: the runtime stores the redacted url");
  const events = {
    network: [
      { kind: "http", url: seenByRuntime, status: 500 },
      { kind: "http", url: redact("http://a.test/api/other?token=zzz"), status: 500 },
    ],
    console: [],
  };
  for (const url of [raw, seenByRuntime]) {
    const filtered = withoutExpectedFailures(events, [{ url, glob: "**/api/orders*", how: 500 }]);
    assert.deepEqual(filtered.network.map((item) => item.url), [redact("http://a.test/api/other?token=zzz")]);
  }
});

test("cli: --journey names journeys on the journeys command, like --only", async () => {
  const dir = await project({
    ".visual-qa.yml": "journeys:\n  a: ./gone-a.mjs\n  b: ./gone-b.mjs\n",
  });
  const run = (...args) =>
    spawnSync(process.execPath, [CLI, "journeys", "--url", "http://127.0.0.1:1", ...args], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  // Only the named journey is resolved: a missing file of the other one does not matter.
  assert.match(run("--journey", "a").stderr, /journey "a": file not found: .*gone-a\.mjs/);
  assert.match(run("--journey", "b").stderr, /journey "b": file not found: .*gone-b\.mjs/);
  assert.match(run("--only", "b", "--journey", "a").stderr, /journey "b": file not found/);
  assert.match(run("--journey", "nope").stderr, /unknown journey "nope"; known: a, b/);
  assert.match(run().stderr, /journey "a": file not found/);
});

test("cli: states and journeys need a config, known names and a loadable setup (exit 2, no browser)", async () => {
  const run = (cwd, ...args) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
  const empty = await project({});
  const noConfig = run(empty, "explore", "--url", "http://127.0.0.1:1", "--state", "a");
  assert.equal(noConfig.status, 2);
  assert.match(noConfig.stderr, /come from \.visual-qa\.yml/);

  const dir = await project({
    ".visual-qa.yml": "setup: ./gone.mjs\nstates:\n  a:\n    path: /a\nmystery: 1\n",
  });
  const missingSetup = run(dir, "explore", "--url", "http://127.0.0.1:1", "--state", "a");
  assert.equal(missingSetup.status, 2);
  assert.match(missingSetup.stderr, /setup file not found/);
  assert.match(missingSetup.stderr, /warning: unknown key "mystery"/);

  const noJourneys = run(dir, "journeys", "--url", "http://127.0.0.1:1");
  assert.equal(noJourneys.status, 2);
  assert.match(noJourneys.stderr, /no journeys defined/);

  const gone = run(dir, "explore", "--url", "http://127.0.0.1:1", "--state", "a", "--config", "nope.yml");
  assert.equal(gone.status, 2);
  assert.match(gone.stderr, /config file not found: .*nope\.yml/);

  // A state that would inject nothing, or sections written in a form that is not read: exit 2, never a quiet pass.
  for (const [yaml, message] of [
    ["states:\n  a:\n    path: /a\n    expect_api: 500\n", /state "a": expect_api must map a URL glob/],
    ["states:\n  a:\n    path: /a\n    expect_api:\n", /state "a": expect_api must map a URL glob/],
    ["states: {a: {path: /a}}\n", /line 1: inline/],
  ]) {
    const bad = run(await project({ ".visual-qa.yml": yaml }), "explore", "--url", "http://127.0.0.1:1", "--state", "a");
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, message);
  }

  const only = run(dir, "explore", "--url", "http://127.0.0.1:1", "--only", "a");
  assert.equal(only.status, 2);
  assert.match(only.stderr, /--only belongs to the journeys command/);
});

test("readme shows the shipped example files verbatim", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  for (const file of ["vqa.setup.mjs", "checkout.journey.mjs", ".visual-qa.yml"]) {
    const content = await readFile(join(ROOT, "fixture", "example", file), "utf8");
    assert.ok(readme.includes(content), `README.md must contain fixture/example/${file} verbatim`);
  }
});

// What an error state owes the reader, judged in a real page against the same
// page without the failure: a reason and a control in the content area that the
// failure added.
test("error state: reason and way forward are judged on what a reader can see and use", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const signals = async (html) => {
    await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`);
    return readErrorSignals(page);
  };
  const ALERT = '<p role="alert">Sorry about that.</p>';
  const WORDS = "<p>Could not load your orders.</p>";
  const BUTTON = "<button>Try again</button>";
  const FINE = "<main><p>Fine.</p></main>";
  const cases = [
    ["alert and button", `<main>${ALERT}${BUTTON}</main>`, null, true, true],
    ["status text and link", `<main><p role="status">Offline.</p><a href="/">Back</a></main>`, null, true, true],
    ["live region", `<main><p aria-live="polite">Offline.</p>${BUTTON}</main>`, null, true, true],
    ["error words in the content, no alert", `<main>${WORDS}<a href="/">Back</a></main>`, null, false, true],
    ["nothing at all", FINE, null, false, false],
    ["disabled button", `<main>${ALERT}<button disabled>Try again</button></main>`, null, true, false],
    ["tabindex -1 only", `<main>${ALERT}<div tabindex="-1">x</div></main>`, null, true, false],
    ["hidden button", `<main>${ALERT}<button hidden>Try again</button><button style="display:none">x</button></main>`, null, true, false],
    ["hidden input", `<main>${ALERT}<input type="hidden" value="x"></main>`, null, true, false],
    ["alert that is empty", '<main><p role="alert"></p><p>Fine.</p></main>', null, false, false],
    ["hidden alert", '<main><p role="alert" hidden>Gone.</p><p>Fine.</p></main>', null, false, false],
    ["control in header", `<header><a href="/">Home</a></header><main>${ALERT}</main>`, null, true, false],
    ["control in nav", `<nav><a href="/">Home</a></nav><main>${ALERT}</main>`, null, true, false],
    ["control in footer", `<main>${ALERT}</main><footer><a href="/">Help</a></footer>`, null, true, false],
    ["control in aside", `<main>${ALERT}<aside><a href="/">Related</a></aside></main>`, null, true, false],
    ["control outside main", `<div>${BUTTON}</div><main>${ALERT}</main>`, null, true, false],
    ["no main: body counts", `${ALERT}${BUTTON}`, null, true, true],
    ["reason text present, any case", `<main><p>COULD NOT LOAD</p>${BUTTON}</main>`, "could not load", true, true],
    ["reason text absent although an alert shows", `<main>${ALERT}${BUTTON}</main>`, "could not load", false, true],
  ];
  const healthy = await signals(FINE);
  for (const [name, html, reason, hasReason, hasWayForward] of cases)
    assert.deepEqual(judgeErrorState(await signals(html), healthy, reason), { hasReason, hasWayForward }, name);

  // A page that swallows the failure and merely looks like an error page: the same
  // words in the content, the same alert region and the same links as when healthy.
  const DOCS = `<header><a href="/">Home</a></header><main><h1>Docs</h1><p>Error handling is covered in chapter 3. We could not be happier.</p>
    <div role="status">Docs are up to date.</div><a href="/ch3">Chapter 3</a><button>Search</button></main>`;
  assert.deepEqual(judgeErrorState(await signals(DOCS), await signals(DOCS), null), {
    hasReason: false,
    hasWayForward: false,
  });
  // The same page reacting to the failure: a new alert and a new control count, old ones do not.
  const REACTED = DOCS.replace("</main>", `<p role="alert">Could not refresh.</p><button>Retry</button></main>`);
  assert.deepEqual(judgeErrorState(await signals(REACTED), await signals(DOCS), null), {
    hasReason: true,
    hasWayForward: true,
  });
  // A configured reason is read as text on the error page (the healthy page does not matter).
  assert.equal(judgeErrorState(await signals(DOCS), await signals(DOCS), "docs are up").hasReason, true);
});
