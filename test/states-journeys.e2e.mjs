import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAppServer } from "../fixture/app-server.mjs";
import { agentRun, parseVisualQaYaml } from "../src/agent-run.mjs";
import { explore } from "../src/explore.mjs";
import { resolveSessionInput, SetupError } from "../src/session.mjs";

const ROOT = resolve(import.meta.dirname, "..");

// The app fixture lives in this process, so the CLI must not block the event
// loop (spawnSync would starve the server it is talking to).
const runCli = (cwd, ...args) =>
  new Promise((done) =>
    execFile(
      process.execPath,
      [join(ROOT, "bin", "visual-qa.mjs"), ...args],
      { cwd, encoding: "utf8", timeout: 120_000 },
      (error, stdout, stderr) => done({ status: error ? error.code : 0, stdout, stderr }),
    ),
  );
const EXAMPLE = join(ROOT, "fixture", "example");
const server = createAppServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const DESKTOP = [{ name: "desktop", width: 1280, height: 800 }];
const BOUNDS = { max_runtime_ms: 120_000 };

// A project dir whose config points at the shipped example files, plus extras.
async function inProject(yaml, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vqa-sj-"));
  await writeFile(join(dir, ".visual-qa.yml"), yaml);
  for (const [name, content] of Object.entries(files))
    await writeFile(join(dir, name), content);
  return dir;
}

async function check(dir, { states = [], journeys = [] }) {
  const config = parseVisualQaYaml(await readFile(join(dir, ".visual-qa.yml"), "utf8"));
  const input = await resolveSessionInput(config, { baseDir: dir, states, journeys });
  const outDir = await mkdtemp(join(tmpdir(), "vqa-sj-out-"));
  const report = await explore({ ...input, baseUrl, outDir, viewports: DESKTOP, bounds: BOUNDS });
  return { report, outDir };
}

const titles = (report) => report.issues.map((item) => item.title);
const SETUP = `setup: ${join(EXAMPLE, "vqa.setup.mjs")}\n`;
const ORDERS = "states:\n  orders:\n    path: /orders\n";

test("sign-in setup: the signed-in state is clean, the same state without setup is red", async () => {
  const green = await check(await inProject(SETUP + ORDERS), { states: ["orders"] });
  assert.deepEqual(titles(green.report), []);
  assert.equal(green.report.verdict, "PASS");
  assert.equal(green.report.complete, true);
  const text = await readFile(join(green.outDir, "screenshots", "appstate-orders-desktop.txt"), "utf8");
  assert.match(text, /Order 1001/);

  const red = await check(await inProject(ORDERS), { states: ["orders"] });
  assert.ok(titles(red.report).includes("Network request failed"), titles(red.report).join());
  assert.equal(red.report.verdict, "FAIL");
});

test("a state's own setup runs after the global one and can stub a route", async () => {
  const dir = await inProject(
    "setup: ./hooks.mjs\nstates:\n  stubbed:\n    path: /orders\n    setup: seeded\n  plain:\n    path: /orders\n",
    {
      "hooks.mjs":
        'export async function setup(page, ctx) { await page.context().addCookies([{ name: "sid", value: "demo", url: ctx.baseUrl }]); }\n' +
        'export async function seeded(page) { await page.route("**/api/orders", (route) => route.fulfill({ json: ["Order 9999"] })); }\n',
    },
  );
  const { report, outDir } = await check(dir, { states: ["stubbed", "plain"] });
  assert.deepEqual(titles(report), []);
  const read = (name) => readFile(join(outDir, "screenshots", `appstate-${name}-desktop.txt`), "utf8");
  assert.match(await read("stubbed"), /Order 9999/);
  assert.doesNotMatch(await read("plain"), /Order 9999/);
});

test("storage_state signs in without any setup file", async () => {
  const dir = await inProject("storage_state: ./auth.json\n" + ORDERS, {
    "auth.json": JSON.stringify({
      cookies: [
        { name: "sid", value: "demo", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
      ],
      origins: [],
    }),
  });
  const { report } = await check(dir, { states: ["orders"] });
  assert.deepEqual(titles(report), []);
});

test("a fresh state skips the session: the account page sends a signed-out visitor to sign-in", async () => {
  const dir = await inProject(
    SETUP + "states:\n  account:\n    path: /account\n  account-out:\n    path: /account\n    fresh: true\n",
  );
  const { outDir } = await check(dir, { states: ["account", "account-out"] });
  const read = (name) => readFile(join(outDir, "screenshots", `appstate-${name}-desktop.txt`), "utf8");
  assert.match(await read("account"), /Welcome back/);
  const out = await read("account-out");
  assert.match(out, /Sign in/);
  assert.doesNotMatch(out, /Welcome back/);
});

test("an expected 500 or timeout with reason and retry is no finding", async () => {
  for (const [glob, how] of [["**/api/orders", "500"], ["**/api/orders", "timeout"], ["/api/orders", "503"]]) {
    const dir = await inProject(
      SETUP + `states:\n  broken:\n    path: /orders\n    expect_api:\n      "${glob}": ${how}\n`,
    );
    const { report, outDir } = await check(dir, { states: ["broken"] });
    assert.deepEqual(titles(report), [], `${glob} ${how}`);
    const text = await readFile(join(outDir, "screenshots", "appstate-broken-desktop.txt"), "utf8");
    assert.match(text, /Could not load your orders/, `${glob} ${how}`);
  }
});

test("an error state without reason or without way forward is a medium finding", async () => {
  const dir = await inProject(
    SETUP +
      [
        "states:",
        "  silent:",
        "    path: /orders-silent",
        "    expect_api:",
        '      "**/api/orders": 500',
        "  stuck:",
        "    path: /orders-reason-only",
        "    expect_api:",
        '      "**/api/orders": 500',
        "  wrong-reason:",
        "    path: /orders",
        "    reason: Something else entirely",
        "    expect_api:",
        '      "**/api/orders": 500',
        "",
      ].join("\n"),
  );
  const { report } = await check(dir, { states: ["silent", "stuck", "wrong-reason"] });
  const byState = (state) =>
    report.issues.filter((item) => item.evidence?.state === state).map((item) => [item.title, item.severity]);
  assert.deepEqual(byState("silent").sort(), [
    ["Error state silent offers no way forward", "medium"],
    ["Error state silent shows no reason", "medium"],
  ]);
  assert.deepEqual(byState("stuck"), [["Error state stuck offers no way forward", "medium"]]);
  assert.deepEqual(byState("wrong-reason"), [["Error state wrong-reason shows no reason", "medium"]]);
  assert.equal(report.verdict, "UNPROVEN");
});

test("an injected failure on a url with a secret-like query is no finding either", async () => {
  const dir = await inProject(
    SETUP + 'states:\n  tokened:\n    path: /orders-token\n    expect_api:\n      "**/api/orders*": 500\n',
  );
  const { report, outDir } = await check(dir, { states: ["tokened"] });
  assert.deepEqual(titles(report), []);
  assert.equal(report.verdict, "PASS");
  assert.match(await readFile(join(outDir, "screenshots", "appstate-tokened-desktop.txt"), "utf8"), /Could not load your orders/);
});

test("a page that swallows the failure is not rescued by error words and links in its normal content", async () => {
  const dir = await inProject(
    SETUP + 'states:\n  docs:\n    path: /docs\n    expect_api:\n      "**/api/orders": 500\n',
  );
  const { report } = await check(dir, { states: ["docs"] });
  assert.deepEqual(titles(report).sort(), [
    "Error state docs offers no way forward",
    "Error state docs shows no reason",
  ]);
  assert.equal(report.verdict, "UNPROVEN");
});

test("the setup hook sees the state's name, also when the state is picked as path@name", async () => {
  const dir = await inProject(
    "setup: ./hooks.mjs\nstates:\n  orders-error:\n    path: /orders\n    expect_api:\n      \"**/api/orders\": 500\n",
    {
      "hooks.mjs":
        'import { appendFile } from "node:fs/promises";\n' +
        'export async function setup(page, ctx) { await appendFile(new URL("./seen.log", import.meta.url), `${ctx.state}\\n`); await page.context().addCookies([{ name: "sid", value: "demo", url: ctx.baseUrl }]); }\n',
    },
  );
  await check(dir, { states: ["/orders@orders-error", "orders-error"] });
  const seen = (await readFile(join(dir, "seen.log"), "utf8")).trim().split("\n");
  assert.ok(seen.length >= 2, seen.join());
  assert.deepEqual([...new Set(seen)], ["orders-error"]);
});

test("the usual checks run in a state: accessibility, layout, scroll chrome and placeholder copy", async () => {
  const dir = await inProject(
    "states:\n  defects:\n    path: /defects\n  draft:\n    path: /draft\n",
  );
  const { report } = await check(dir, { states: ["defects", "draft"] });
  const found = report.issues.map((item) => `${item.type}: ${item.title}`);
  for (const expected of [
    "vqa-accessibility: Images must have alternative text",
    "vqa-accessibility: Elements must meet minimum color contrast ratio thresholds",
    "vqa-visual: Horizontal overflow",
    "vqa-visual: Fixed chrome overlaps",
    "vqa-slop: Lorem ipsum placeholder copy",
  ])
    assert.ok(found.includes(expected), `${expected} missing in: ${found.join(" | ")}`);
  assert.equal(report.verdict, "FAIL");
});

test("an injected failure that the page never requests is reported, not trusted", async () => {
  const dir = await inProject(
    SETUP + 'states:\n  home:\n    path: /\n    expect_api:\n      "**/api/orders": 500\n',
  );
  const { report } = await check(dir, { states: ["home"] });
  assert.deepEqual(titles(report), ["Injected failure never requested in state home"]);
  assert.equal(report.issues[0].severity, "low");
});

test("a throwing setup blocks the run instead of producing findings", async () => {
  const dir = await inProject("setup: ./boom.mjs\n" + ORDERS, {
    "boom.mjs": 'export async function setup() { throw new Error("no credentials"); }\n',
  });
  await assert.rejects(
    check(dir, { states: ["orders"] }),
    (error) => error instanceof SetupError && /setup failed for state "orders": no credentials/.test(error.message),
  );
  const cli = await runCli(dir, "explore", "--url", baseUrl, "--state", "orders", "--out", join(dir, "out"));
  assert.equal(cli.status, 2, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /Visual QA BLOCKED: setup failed for state "orders": no credentials/);
});

test("naming a state narrows the run to it: no base-URL walk", async () => {
  const { report } = await check(await inProject(SETUP + ORDERS), { states: ["orders"] });
  assert.deepEqual(report.states.map((item) => item.kind), ["app_state"]);
  assert.equal(report.coverage.states, 1);
  assert.equal(report.coverage.actions, 0);
  assert.deepEqual(report.coverage.viewports_covered, ["desktop"]);
});

test("the README example runs as written: three states and the checkout journey are clean", async () => {
  const { report, outDir } = await check(EXAMPLE, {
    states: ["orders", "orders-error", "signed-out"],
    journeys: ["checkout"],
  });
  assert.deepEqual(titles(report), []);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.complete, true);
  assert.equal(report.coverage.states, 8);
  assert.deepEqual(report.coverage.viewports_covered, ["desktop"]);
  const dir = join(outDir, "journeys", "checkout", "desktop");
  const files = (await readdir(dir)).sort();
  assert.equal(files.filter((name) => name.endsWith(".png")).length, 5);
  assert.equal(files.filter((name) => name.endsWith(".txt")).length, 5);
  assert.match(await readFile(join(dir, "05-order_is_confirmed.txt"), "utf8"), /Order placed/);
  assert.match(
    await readFile(join(outDir, "screenshots", "appstate-signed-out-desktop.txt"), "utf8"),
    /Sign in/,
  );
});

test("journey: a red check fails the run, names the step and leaves a stop image; later steps do not run", async () => {
  const { report, outDir } = await check(
    await inProject(
      SETUP + `journeys:\n  broken: ${join(ROOT, "test", "journeys", "broken.journey.mjs")}\n`,
    ),
    { journeys: ["broken"] },
  );
  assert.equal(report.verdict, "FAIL");
  const failure = report.issues.find((item) => item.type === "vqa-journey");
  assert.equal(failure.title, "Journey broken failed at check receipt is shown");
  assert.equal(failure.severity, "high");
  assert.match(failure.detail, /check returned false/);
  await access(failure.evidence.screenshot);
  assert.match(failure.evidence.screenshot, /02-receipt_is_shown-FAILED\.png$/);
  const files = await readdir(join(outDir, "journeys", "broken", "desktop"));
  assert.equal(files.some((name) => name.startsWith("03-")), false, files.join());
});

test("the usual checks run after every green journey step: accessibility and layout", async () => {
  const dir = await inProject(
    "journeys:\n  defects: ./defects.mjs\n",
    {
      // A relative target resolves against --url, like in any Playwright script.
      "defects.mjs": 'export default async ({ step }) => { await step("open defects", (page) => page.goto("/defects")); };\n',
    },
  );
  const { report } = await check(dir, { journeys: ["defects"] });
  const found = report.issues.map((item) => `${item.type}: ${item.title}`);
  assert.ok(!found.some((title) => title.startsWith("vqa-journey")), found.join(" | "));
  for (const expected of [
    "vqa-accessibility: Images must have alternative text",
    "vqa-visual: Horizontal overflow",
  ])
    assert.ok(found.includes(expected), `${expected} missing in: ${found.join(" | ")}`);
});

test("journey: fresh runs without the session, a normal one runs with it", async () => {
  const open = 'export default async ({ step }) => { await step("open login", (page, ctx) => page.goto(new URL("/login", ctx.baseUrl).href)); };\n';
  const dir = await inProject(
    SETUP + "journeys:\n  signed: ./open.mjs\n  anon:\n    file: ./open.mjs\n    fresh: true\n",
    { "open.mjs": open },
  );
  const { outDir } = await check(dir, { journeys: ["signed", "anon"] });
  const text = (name) =>
    readFile(join(outDir, "journeys", name, "desktop", "01-open_login.txt"), "utf8");
  assert.match(await text("signed"), /Welcome back/);
  assert.match(await text("anon"), /Sign in/);
});

test("journey: a click that never finds its target is a red step, not a hang", async () => {
  const dir = await inProject(
    SETUP + "journeys:\n  hang: ./hang.mjs\n",
    {
      "hang.mjs":
        'export default async ({ step }) => { await step("press missing", (page, ctx) => page.goto(new URL("/", ctx.baseUrl).href).then(() => page.getByRole("button", { name: "Nope" }).click())); };\n',
    },
  );
  const started = Date.now();
  const config = parseVisualQaYaml(await readFile(join(dir, ".visual-qa.yml"), "utf8"));
  const input = await resolveSessionInput(config, { baseDir: dir, journeys: ["hang"] });
  const report = await explore({
    ...input,
    baseUrl,
    outDir: await mkdtemp(join(tmpdir(), "vqa-sj-out-")),
    viewports: DESKTOP,
    bounds: BOUNDS,
    navigation_timeout_ms: 2_000,
  });
  assert.equal(report.issues.find((item) => item.type === "vqa-journey").title, "Journey hang failed at step press missing");
  assert.ok(Date.now() - started < 20_000);
});

test("agent-run: a path@state route captures the named state, plain walk is skipped", async () => {
  const dir = await inProject(
    SETUP +
      'mystery: 1\nroute_map:\n  "src/**":\n    - /orders@orders-error\n' +
      'states:\n  orders-error:\n    path: /orders\n    expect_api:\n      "**/api/orders": 500\n',
  );
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "App.tsx"), "export const a = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  await writeFile(join(dir, "src", "App.tsx"), "export const a = 2;\n");
  const env = { ...process.env };
  process.env.VQA_VISION_DISABLE = "1";
  try {
    const result = await agentRun({
      url: baseUrl,
      outDir: join(dir, "out"),
      projectRoot: dir,
      viewports: DESKTOP,
      bounds: BOUNDS,
    });
    assert.deepEqual(result.agent.states, ["/orders@orders-error"]);
    assert.deepEqual(result.agent.config_warnings, ['unknown key "mystery" in .visual-qa.yml (ignored)']);
    assert.deepEqual(result.report.states.map((item) => item.kind), ["app_state"]);
    assert.deepEqual(
      result.report.issues.filter((item) => item.type !== "vqa-vision"),
      [],
    );
    await access(join(dir, "out", "screenshots", "appstate-_orders_orders-error-desktop.txt"));
  } finally {
    if (env.VQA_VISION_DISABLE === undefined) delete process.env.VQA_VISION_DISABLE;
    else process.env.VQA_VISION_DISABLE = env.VQA_VISION_DISABLE;
  }
});

test("journey: a check says why with a string, and forgetting to return is red, not green", async () => {
  const dir = await inProject(
    SETUP + "journeys:\n  reason: ./reason.mjs\n  forgot: ./forgot.mjs\n",
    {
      "reason.mjs": 'export default async ({ check }) => { await check("total", async () => "total is 12, expected 10"); };\n',
      "forgot.mjs": 'export default async ({ check }) => { await check("total", async () => {}); };\n',
    },
  );
  const { report } = await check(dir, { journeys: ["reason", "forgot"] });
  const details = Object.fromEntries(
    report.issues.filter((item) => item.type === "vqa-journey").map((item) => [item.evidence.journey, item.detail]),
  );
  assert.match(details.reason, /total is 12, expected 10/);
  assert.match(details.forgot, /check returned undefined; return true/);
});

test("journey: a journey that never calls step() or check() proves nothing and says so", async () => {
  const dir = await inProject(SETUP + "journeys:\n  empty: ./empty.mjs\n", {
    "empty.mjs": "export default async () => {};\n",
  });
  const { report } = await check(dir, { journeys: ["empty"] });
  assert.deepEqual(titles(report), ["Journey empty recorded no steps"]);
  assert.equal(report.issues[0].severity, "medium");
});

test("journey: a throw outside a step is a finding with a stop image", async () => {
  const dir = await inProject(SETUP + "journeys:\n  loose: ./loose.mjs\n", {
    "loose.mjs": 'export default async () => { throw new Error("boom outside"); };\n',
  });
  const { report } = await check(dir, { journeys: ["loose"] });
  assert.equal(report.verdict, "FAIL");
  const failure = report.issues.find((item) => item.type === "vqa-journey");
  assert.equal(failure.title, "Journey loose threw outside a step");
  assert.match(failure.detail, /boom outside/);
  await access(failure.evidence.screenshot);
});

test("the run budget ends state and journey capture as incomplete, not as silence", async () => {
  // The first state takes 1.2 s in its setup, so the 1 s budget is gone before the second one starts.
  const dir = await inProject(
    "setup: ./slow.mjs\nstates:\n  first:\n    path: /\n  second:\n    path: /\n" +
      "journeys:\n  checkout: " + join(EXAMPLE, "checkout.journey.mjs") + "\n",
    { "slow.mjs": "export const setup = () => new Promise((done) => setTimeout(done, 1200));\n" },
  );
  const config = parseVisualQaYaml(await readFile(join(dir, ".visual-qa.yml"), "utf8"));
  const input = await resolveSessionInput(config, { baseDir: dir, states: ["first", "second"], journeys: ["checkout"] });
  const outDir = await mkdtemp(join(tmpdir(), "vqa-sj-out-"));
  const report = await explore({ ...input, baseUrl, outDir, viewports: DESKTOP, bounds: { max_runtime_ms: 1_000 } });
  assert.equal(report.verdict, "COVERAGE_INCOMPLETE");
  assert.equal(report.coverage.limit_reason, "max_runtime_ms");
  assert.equal(report.coverage.states, 1);
  await assert.rejects(access(join(outDir, "screenshots", "appstate-second-desktop.png")));
  await assert.rejects(access(join(outDir, "journeys")));
});

test("a state that cannot be loaded is an incomplete run with a named finding", async () => {
  const dir = await inProject(SETUP + ORDERS);
  const config = parseVisualQaYaml(await readFile(join(dir, ".visual-qa.yml"), "utf8"));
  const input = await resolveSessionInput(config, { baseDir: dir, states: ["orders"] });
  const report = await explore({
    ...input,
    baseUrl: "http://127.0.0.1:1",
    outDir: await mkdtemp(join(tmpdir(), "vqa-sj-out-")),
    viewports: DESKTOP,
    bounds: BOUNDS,
  });
  assert.equal(report.verdict, "COVERAGE_INCOMPLETE");
  assert.equal(report.coverage.limit_reason, "state_error");
  const finding = report.issues.find((item) => item.type === "vqa-state");
  assert.equal(finding.title, "State orders could not be captured");
  assert.equal(finding.severity, "high");
});

test("cli: a red journey exits 1, a green one exits 0, --only and --journey pick by name", async () => {
  const dir = await inProject(
    SETUP +
      `journeys:\n  checkout: ${join(EXAMPLE, "checkout.journey.mjs")}\n  broken: ${join(ROOT, "test", "journeys", "broken.journey.mjs")}\n`,
  );
  const cli = (...args) => runCli(dir, "journeys", "--url", baseUrl, ...args);
  const green = await cli("--only", "checkout", "--out", join(dir, "green"));
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /Visual QA PASS/);
  const red = await cli("--only", "broken", "--out", join(dir, "red"));
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /HIGH vqa-journey-journey-broken-failed-at-check-receipt-is-shown/);
  // --journey is the same switch as on run/explore: only the named journey runs.
  const named = await cli("--journey", "checkout", "--out", join(dir, "named"));
  assert.equal(named.status, 0, named.stdout + named.stderr);
  assert.match(named.stdout, /Visual QA PASS/);
  const both = await cli("--only", "checkout", "--journey", "broken", "--out", join(dir, "both"));
  assert.equal(both.status, 1, both.stdout + both.stderr);
  const unknown = await cli("--only", "nope");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown journey "nope"; known: checkout, broken/);
});

test("agent-run: plain and state routes together walk the plain one and capture the state", async () => {
  const dir = await inProject(
    SETUP +
      'route_map:\n  "src/**":\n    - /\n    - /orders@orders-error\n' +
      'states:\n  orders-error:\n    path: /orders\n    expect_api:\n      "**/api/orders": 500\n',
  );
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "App.tsx"), "export const a = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  await writeFile(join(dir, "src", "App.tsx"), "export const a = 2;\n");
  process.env.VQA_VISION_DISABLE = "1";
  try {
    const result = await agentRun({
      url: baseUrl,
      outDir: join(dir, "out"),
      projectRoot: dir,
      viewports: DESKTOP,
      bounds: BOUNDS,
    });
    assert.equal(result.agent.mode, "changed");
    const kinds = result.report.states.map((item) => item.kind);
    assert.equal(kinds.filter((kind) => kind === "app_state").length, 1);
    assert.ok(kinds.some((kind) => kind === undefined), "the plain route / was not walked");
    assert.deepEqual(result.report.states.filter((item) => item.url.includes("@")), [], "a state route was walked as a page");
  } finally {
    delete process.env.VQA_VISION_DISABLE;
  }
});
