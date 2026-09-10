import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { chromium } from "playwright";
import { probeEdgeValuesFor, probeValueFor } from "../src/browser.mjs";
import { explore } from "../src/explore.mjs";
import { runSlopChecks } from "../src/slop.mjs";

const exists = (path) => access(path).then(() => true, () => false);

function serve(html) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

test("probeValueFor covers supported input types deterministically", () => {
  const values = new Map([
    ["email", "qa@example.invalid"],
    ["password", "Visual-QA-Probe-1!"],
    ["tel", "+15550100"],
    ["url", "https://example.invalid/qa"],
    ["search", "Visual QA"],
    ["text", "Visual QA"],
    ["date", "2026-01-15"],
    ["time", "12:30"],
    ["datetime-local", "2026-01-15T12:30"],
    ["month", "2026-01"],
    ["week", "2026-W03"],
  ]);
  for (const [type, expected] of values)
    assert.equal(probeValueFor({ role: "textbox", type }), expected, type);
  assert.equal(probeValueFor({ role: "spinbutton", min: "4" }), "4");
  assert.equal(probeValueFor({ role: "spinbutton" }), "1");
  assert.equal(probeValueFor({ role: "slider", min: "10", max: "30" }), "20");
  assert.equal(probeValueFor({ role: "textbox", tag: "textarea" }), "Visual QA");
});

test("probeEdgeValuesFor covers empty/hostile/overlong text surfaces", () => {
  const text = probeEdgeValuesFor({ role: "textbox", type: "text" });
  assert.deepEqual(
    text.map((edge) => edge.kind),
    ["empty", "hostile", "overlong"],
  );
  assert.equal(text.find((edge) => edge.kind === "hostile").value.includes("onerror"), true);
  assert.equal(text.find((edge) => edge.kind === "overlong").value.length, 200);

  const password = probeEdgeValuesFor({ role: "textbox", type: "password" });
  assert.deepEqual(
    password.map((edge) => edge.kind),
    ["empty", "overlong"],
  );

  const email = probeEdgeValuesFor({ role: "textbox", type: "email" });
  assert.ok(email.some((edge) => edge.kind === "invalid"));

  assert.deepEqual(probeEdgeValuesFor({ role: "button" }), []);
});

test("form-heavy exploration types values and writes action plus state images", async () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Form surface</title><meta name="description" content="QA form"></head><body>
  <h1>Profile</h1>
  <label>Email <input id="email" type="email"></label>
  <label>Password <input id="password" type="password"></label>
  <label>Count <input id="count" type="number" min="3"></label>
  <label>Phone <input id="phone" type="tel"></label>
  <label>Website <input id="website" type="url"></label>
  <label>Search <input id="search" type="search"></label>
  <label>Date <input id="date" type="date"></label>
  <label>Time <input id="time" type="time"></label>
  <label>Notes <textarea id="notes"></textarea></label>
  <label>Plan <select id="plan"><option value="">Choose</option><option value="pro">Pro</option></select></label>
  <label>Seats <input id="seats" type="range" min="2" max="8"></label>
  <label><input id="terms" type="checkbox"> Terms</label>
  <p id="values"></p>
  <script>document.addEventListener('input',()=>{values.textContent=[email.value,password.value,count.value,phone.value,website.value,search.value,date.value,time.value,notes.value,plan.value,seats.value,terms.checked].join('|')});document.addEventListener('change',()=>document.dispatchEvent(new Event('input')));</script>
  </body></html>`;
  const server = await serve(html);
  const outDir = await mkdtemp(`${tmpdir()}/vqa-input-evidence-`);
  try {
    const port = server.address().port;
    const report = await explore({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      bounds: {
        max_states: 20,
        max_depth: 3,
        max_actions_per_state: 20,
        max_total_actions: 30,
        max_runtime_ms: 120_000,
      },
    });
    const observed = report.evidence.filter(
      (entry) =>
        entry.observation?.status === "observed" &&
        entry.kind !== "edge_input" &&
        entry.kind !== "state_scan" &&
        entry.control,
    );
    assert.ok(observed.length >= 10, `observed=${observed.length}`);
    for (const entry of observed) {
      assert.ok(await exists(entry.before.screenshot), entry.before.screenshot);
      assert.ok(await exists(entry.after.screenshot), entry.after.screenshot);
      assert.equal("value" in entry.control, false);
      assert.equal("selectedValue" in entry.control, false);
    }
    const scans = report.evidence.filter((entry) => entry.kind === "state_scan");
    assert.ok(scans.length >= 1);
    for (const scan of scans) assert.ok(await exists(scan.screenshot), scan.screenshot);
    const byId = new Map(observed.map((entry) => [entry.control.id, entry]));
    assert.equal(byId.get("email")?.after.dom.includes("qa@example.invalid"), true);
    assert.equal(byId.get("count")?.control.role, "spinbutton");
    assert.equal(byId.get("count")?.observation.control_changed, true);
    assert.equal(byId.get("plan")?.control.role, "combobox");
    assert.equal(byId.get("plan")?.observation.control_changed, true);

    // Edge probes + mid frames are part of a thorough walk.
    const edges = report.evidence.filter((entry) => entry.kind === "edge_input");
    assert.ok(edges.length >= 3, `edge_input=${edges.length}`);
    const edgeKinds = new Set(edges.map((entry) => entry.edge));
    assert.ok(edgeKinds.has("empty"));
    assert.ok(edgeKinds.has("hostile") || edgeKinds.has("overlong"));
    for (const edge of edges) {
      assert.ok(await exists(edge.before.screenshot), edge.before.screenshot);
      assert.ok(await exists(edge.after.screenshot), edge.after.screenshot);
    }
    const withMid = observed.filter((entry) => entry.mid?.screenshot);
    assert.ok(withMid.length >= 1, "expected at least one mid-action frame");
    for (const entry of withMid)
      assert.ok(await exists(entry.mid.screenshot), entry.mid.screenshot);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(outDir, { recursive: true, force: true });
  }
});

test("edge input probes can be disabled", async () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title><meta name="description" content="t"></head><body>
  <label>Name <input id="name" type="text"></label>
  </body></html>`;
  const server = await serve(html);
  const outDir = await mkdtemp(`${tmpdir()}/vqa-no-edge-`);
  try {
    const port = server.address().port;
    const report = await explore({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      edgeInputProbes: false,
      bounds: {
        max_states: 4,
        max_depth: 2,
        max_actions_per_state: 4,
        max_total_actions: 8,
        max_runtime_ms: 30_000,
      },
    });
    assert.equal(
      report.evidence.filter((entry) => entry.kind === "edge_input").length,
      0,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(outDir, { recursive: true, force: true });
  }
});

test("editable combobox is typed into for typeahead", async () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Typeahead</title><meta name="description" content="t"></head><body>
  <label>City
    <input id="city" role="combobox" aria-autocomplete="list" aria-expanded="false">
  </label>
  <ul id="list" role="listbox" hidden></ul>
  <script>
    const input = document.getElementById('city');
    const list = document.getElementById('list');
    input.addEventListener('input', () => {
      list.hidden = !input.value;
      input.setAttribute('aria-expanded', String(Boolean(input.value)));
      list.innerHTML = input.value
        ? '<li role="option">Visual QA City</li>'
        : '';
    });
  </script>
  </body></html>`;
  const server = await serve(html);
  const outDir = await mkdtemp(`${tmpdir()}/vqa-combo-type-`);
  try {
    const port = server.address().port;
    const report = await explore({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      edgeInputProbes: false,
      bounds: {
        max_states: 6,
        max_depth: 2,
        max_actions_per_state: 6,
        max_total_actions: 10,
        max_runtime_ms: 45_000,
      },
    });
    const combo = report.evidence.find(
      (entry) =>
        entry.control?.role === "combobox" &&
        entry.kind !== "edge_input" &&
        entry.observation?.status === "observed",
    );
    assert.ok(combo, "expected combobox action");
    assert.equal(combo.after.dom.includes("Visual QA"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(outDir, { recursive: true, force: true });
  }
});

test("deterministic slop checks catch gradient glow glass and multi-accent chrome", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html><head><title>Designed</title><meta name="description" content="test"><style>
      body{margin:0}.hero,.gradient-a,.gradient-b{width:100%;height:180px;background-image:linear-gradient(90deg,#f00,#00f)}
      .glow{width:100px;height:50px;margin:8px;box-shadow:0 0 30px rgba(255,0,255,.9)}
      .glass{width:200px;height:80px;background:rgba(255,255,255,.3);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
      .a{background:#f00}.b{background:#0f0}.c{background:#00f}
    </style></head><body><main><section class="hero"><h1>Hero</h1></section>
    <div class="glass"></div><div class="glass"></div><div class="glass"></div>
    <button class="a">A</button><button class="b">B</button><button class="c">C</button>
    <div class="glow"></div><div class="glow"></div><div class="glow"></div>
    <section class="gradient-a"></section><section class="gradient-b"></section></main></body></html>`);
    const issues = await runSlopChecks(page, { viewport: { name: "desktop" } });
    const titles = new Set(issues.map((issue) => issue.title));
    assert.ok(titles.has("Gradient soup / mesh-style chrome"));
    assert.ok(titles.has("Glow / neon overuse"));
    assert.ok(titles.has("Glassmorphism overuse"));
    assert.ok(titles.has("Rainbow / multi-accent chrome"));
  } finally {
    await browser.close();
  }
});
