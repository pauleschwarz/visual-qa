import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { chromium } from "playwright";
import { probeEdgeValuesFor, probeValueFor } from "../src/browser.mjs";
import { explore } from "../src/explore.mjs";
import { runLayoutChecks, runScrollChecks } from "../src/checks.mjs";
import { runSecurityChecks } from "../src/security.mjs";
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

test("interactive mandatory paths expose toggle, text, scroll, and chrome defects", async () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mandatory paths</title><meta name="description" content="QA"></head><body>
  <style>
    body { margin: 0; height: 2200px; }
    #sticky { position: sticky; top: 0; height: 72px; background: #fff; z-index: 2; }
    #covered { position: fixed; top: 0; left: 0; right: 0; height: 72px; background: #111; z-index: 3; }
    #covered-2 { position: fixed; top: 36px; left: 0; right: 0; height: 72px; background: #222; z-index: 4; }
    #long { width: 80px; white-space: nowrap; overflow: hidden; text-overflow: clip; }
    #style-shift { border-radius: 4px; }
    #deep { margin-top: 1200px; }
  </style>
  <div id="sticky">Sticky navigation</div><div id="covered">Pinned status</div>
  <div id="covered-2">Pinned notice</div>
  <label><input id="terms" type="checkbox"> Terms</label>
  <label><input id="radio-a" type="radio" name="plan" checked> Basic</label>
  <label><input id="radio-b" type="radio" name="plan"> Pro</label>
  <button id="darkmode" role="switch" aria-pressed="false">Dark mode</button>
  <button id="style-shift">Change brand</button>
  <label>Notes <input id="long" type="text"></label>
  <button id="deep">Deep action</button>
  <p id="state"></p>
  <script>
    for (const id of ['terms', 'radio-a', 'radio-b', 'long']) {
      document.getElementById(id).addEventListener('change', () => state.textContent = terms.checked + ':' + radio-b.checked + ':' + long.value.length);
    }
    darkmode.addEventListener('click', () => darkmode.setAttribute('aria-pressed', String(darkmode.getAttribute('aria-pressed') !== 'true')));
    document.getElementById('style-shift').addEventListener('click', () => {
      document.body.style.fontFamily = 'serif';
      document.body.style.background = '#3b0764';
      document.querySelectorAll('button').forEach((button) => { button.style.borderRadius = '37px'; button.style.color = '#fde047'; });
    });
    long.addEventListener('input', () => state.textContent = terms.checked + ':' + radio-b.checked + ':' + long.value.length);
  </script></body></html>`;
  const server = await serve(html);
  const outDir = await mkdtemp(`${tmpdir()}/vqa-mandatory-paths-`);
  try {
    const report = await explore({
      baseUrl: `http://127.0.0.1:${server.address().port}/`,
      outDir,
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      bounds: { max_states: 16, max_depth: 3, max_actions_per_state: 12, max_total_actions: 24, max_runtime_ms: 90_000 },
    });
    const observed = report.evidence.filter((entry) => entry.observation?.status === "observed");
    assert.equal(observed.find((entry) => entry.control?.id === "terms")?.observation.control_changed, true);
    assert.equal(observed.find((entry) => entry.control?.id === "radio-b")?.observation.control_changed, true);
    assert.equal(observed.find((entry) => entry.control?.id === "darkmode")?.observation.control_changed, true);
    assert.equal(observed.find((entry) => entry.control?.id === "long")?.observation.control_changed, true);
    assert.ok(report.issues.some((issue) => issue.title === "Fixed chrome overlaps"));
    assert.ok(report.issues.some((issue) => issue.title === "Fixed chrome blocks interactive content while scrolling"));
    assert.ok(report.issues.some((issue) => issue.title === "Interactive content clipped after input"));
    const styleShift = report.issues.find(
      (issue) => issue.title === "Interaction destabilizes visual style identity",
    );
    assert.deepEqual(styleShift?.evidence?.style_identity?.changed.sort(), [
      "colors",
      "fontFamilies",
      "radii",
    ]);
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

test("deterministic slop checks catch marketing fluff type chaos and template cards", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html><head>
      <title>Acme</title><meta name="description" content="product">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400&family=Comic+Neue&family=Papyrus&display=swap" rel="stylesheet">
      <style>
        body{margin:0;font-family:Inter,sans-serif}
        .hero{width:100%;height:200px;background-image:linear-gradient(120deg,#7c3aed,#ec4899,#3b82f6);text-align:center;padding:40px}
        .grid{display:flex;gap:16px;padding:24px}
        .card{width:220px;height:160px;border-radius:12px;background:#fff;box-shadow:0 2px 8px #0002;padding:16px}
        .t1{font-family:"Comic Neue",cursive;font-size:11px;margin-top:5px}
        .t2{font-family:Papyrus,fantasy;font-size:13px;margin-top:7px}
        .t3{font-size:15px;margin-top:9px}
        .t4{font-size:17px;margin-top:11px}
        .t5{font-size:19px;margin-top:14px}
        .t6{font-size:22px;margin-top:18px}
        .t7{font-size:28px;margin-top:23px}
        .r1{border-radius:4px}.r2{border-radius:9px}.r3{border-radius:14px}.r4{border-radius:22px}.r5{border-radius:31px}
      </style></head>
      <body>
        <section class="hero">
          <h1 class="t7">Supercharge your workflow</h1>
          <p class="t6">Unlock the power of our AI-powered platform</p>
          <a href="#">Get started now</a>
        </section>
        <div class="grid">
          <div class="card r1"><h2 class="t5">One</h2><p class="t1">Seamless delight</p></div>
          <div class="card r2"><h2 class="t4">Two</h2><p class="t2">Cutting-edge</p></div>
          <div class="card r3"><h2 class="t3">Three</h2><p class="t3">Next-gen</p></div>
        </div>
        <p class="t1 r4">a</p><p class="t2 r5">b</p><p class="t3">c</p><p class="t4">d</p>
        <p class="t5">e</p><p class="t6">f</p><p class="t7">g</p>
      </body></html>`);
    const issues = await runSlopChecks(page, { viewport: { name: "desktop" } });
    const titles = new Set(issues.map((issue) => issue.title));
    assert.ok(
      titles.has("Fake-SaaS / AI marketing fluff copy"),
      [...titles].join(" | "),
    );
    assert.ok(
      titles.has("Too many font families") || titles.has("Type scale is chaotic"),
      [...titles].join(" | "),
    );
    assert.ok(
      titles.has("Generic template feature-card chrome") ||
        titles.has("Gradient soup / mesh-style chrome"),
      [...titles].join(" | "),
    );
  } finally {
    await browser.close();
  }
});

test("layout clip, sticky occlusion, labeled hit area, and sequential XSS canaries", async () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Probes</title></head><body>
  <style>
    body { margin: 0; height: 1800px; }
    #sticky { position: sticky; top: 0; height: 120px; background: #111; color: #fff; z-index: 9; }
    #long { width: 80px; overflow: hidden; white-space: nowrap; }
    #secret { width: 72px; overflow: hidden; }
    #notes { width: 120px; height: 28px; overflow: hidden; }
    #tiny { width: 12px; height: 12px; padding: 0; }
    label[for=ok] { display: inline-block; min-width: 120px; min-height: 32px; }
    #ok { width: 12px; height: 12px; }
    #deep { margin-top: 900px; }
  </style>
  <div id="sticky">Sticky bar</div>
  <input id="a"><input id="b">
  <div id="sink-a"></div><div id="sink-b"></div>
  <input id="long" type="text" value="${"X".repeat(200)}">
  <input id="secret" type="password" value="${"X".repeat(40)}">
  <textarea id="notes">${"line\n".repeat(40)}</textarea>
  <button id="tiny">.</button>
  <label for="ok">Accept terms of service</label>
  <input id="ok" type="checkbox">
  <div style="height:400px"><p>${"Readable filler. ".repeat(40)}</p></div>
  <button id="deep" style="margin-top:900px">Deep</button>
  <script>
    a.addEventListener('blur', () => document.getElementById('sink-a').innerHTML = a.value);
    b.addEventListener('blur', () => document.getElementById('sink-b').innerHTML = b.value);
  </script>
  </body></html>`;
  const server = await serve(html);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const layout = await runLayoutChecks(page, "desktop");
    const clipped = layout.find((issue) => issue.title === "Interactive content clipped after input");
    const ids = (clipped?.evidence.items || []).map((item) => item.id);
    assert.ok(ids.includes("long"), ids.join(","));
    assert.ok(ids.includes("secret"), ids.join(","));
    assert.ok(ids.includes("notes"), ids.join(","));
    const small = layout.find((issue) => issue.title === "Touch targets below 24px");
    const smallIds = (small?.evidence.items || []).map((item) => item.id || item.text || "").join(" ");
    assert.match(smallIds, /tiny/i);
    assert.doesNotMatch(smallIds, /\bok\b/);
    const scroll = await runScrollChecks(page, "desktop", { samples: 12 });
    assert.ok(
      scroll.some((issue) => issue.title === "Fixed chrome blocks interactive content while scrolling"),
      scroll.map((issue) => issue.title).join(" | "),
    );
    const security = await runSecurityChecks({
      page,
      baseUrl: `http://127.0.0.1:${server.address().port}/`,
      viewport: "desktop",
    });
    const xss = security.filter(
      (issue) => issue.title === "Unescaped HTML reflection in input handling",
    );
    assert.equal(xss.length, 2, xss.map((issue) => issue.evidence.input).join(","));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
