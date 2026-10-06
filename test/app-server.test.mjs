import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { healthEndpoint, withAppServer } from "../src/app-server.mjs";

const CLI = resolve(import.meta.dirname, "..", "bin", "visual-qa.mjs");
const APP_SERVER = resolve(import.meta.dirname, "..", "src", "app-server.mjs");

function freePort() {
  return new Promise((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pids, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !pids.some(alive);
}

/**
 * A server the way `npm run dev` runs: a wrapper process starts the real server as its child.
 * Both write their pid, so a test can see whether the whole tree is gone.
 */
function appFiles(port, { listen = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vqa-server-"));
  writeFileSync(
    join(dir, "server.mjs"),
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "server.pid"))}, String(process.pid));
${listen ? `createServer((req, res) => res.end("ok")).listen(${port}, "127.0.0.1");` : "setInterval(() => {}, 1000);"}
`,
  );
  writeFileSync(
    join(dir, "wrapper.mjs"),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "wrapper.pid"))}, String(process.pid));
spawn(process.execPath, [${JSON.stringify(join(dir, "server.mjs"))}], { stdio: "inherit" });
setInterval(() => {}, 1000);
`,
  );
  const pids = () => ["wrapper.pid", "server.pid"].map((name) => Number(readFileSync(join(dir, name), "utf8")));
  return { dir, command: `node wrapper.mjs`, pids };
}

/** The same app, but wrapper and server both ignore SIGTERM: only SIGKILL of the group stops them. */
function stubborn(app, port) {
  writeFileSync(
    join(app.dir, "server.mjs"),
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(app.dir, "server.pid"))}, String(process.pid));
process.on("SIGTERM", () => {});
createServer((req, res) => res.end("ok")).listen(${port}, "127.0.0.1");
`,
  );
  writeFileSync(
    join(app.dir, "wrapper.mjs"),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(app.dir, "wrapper.pid"))}, String(process.pid));
process.on("SIGTERM", () => {});
spawn(process.execPath, [${JSON.stringify(join(app.dir, "server.mjs"))}], { stdio: "inherit" });
setInterval(() => {}, 1000);
`,
  );
}

test("server: waits for health, runs the work, then stops the whole process tree", async () => {
  const port = await freePort();
  const app = appFiles(port);
  const health = `http://127.0.0.1:${port}/`;
  const listeners = process.listenerCount("SIGTERM") + process.listenerCount("exit");
  const seen = await withAppServer({ command: app.command, health }, async () => (await fetch(health)).text(), {
    cwd: app.dir,
  });
  assert.equal(seen, "ok");
  assert.equal(process.listenerCount("SIGTERM") + process.listenerCount("exit"), listeners, "no handler left behind");
  assert.ok(await gone(app.pids()), "wrapper and server are both gone");
});

test("server: stops it when the work throws", async () => {
  const port = await freePort();
  const app = appFiles(port);
  await assert.rejects(
    withAppServer({ command: app.command, health: `http://127.0.0.1:${port}/` }, async () => {
      throw new Error("run broke");
    }, { cwd: app.dir }),
    /run broke/,
  );
  assert.ok(await gone(app.pids()));
});

test("server: health that never answers is a timeout, with the server's output, and the server is stopped", async () => {
  const port = await freePort();
  const app = appFiles(port, { listen: false });
  const started = Date.now();
  await assert.rejects(
    withAppServer({ command: app.command, health: `http://127.0.0.1:${port}/`, startup_timeout_ms: 1_200 }, async () => {
      assert.fail("must not run");
    }, { cwd: app.dir }),
    /did not answer within 1s/,
  );
  assert.ok(Date.now() - started < 10_000);
  assert.ok(await gone(app.pids()));
});

test("server: a command that dies is named with its exit and output, not waited for", async () => {
  const port = await freePort();
  const started = Date.now();
  await assert.rejects(
    withAppServer(
      { command: `node -e "console.error('port in use'); process.exit(3)"`, health: `http://127.0.0.1:${port}/`, startup_timeout_ms: 30_000 },
      async () => assert.fail("must not run"),
    ),
    /server exited \(code 3\) before .* answered[\s\S]*port in use/,
  );
  assert.ok(Date.now() - started < 10_000);
});

test("server: the health URL must answer ok, a 500 keeps waiting", async () => {
  const port = await freePort();
  const app = appFiles(port);
  writeFileSync(
    join(app.dir, "server.mjs"),
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(app.dir, "server.pid"))}, String(process.pid));
createServer((req, res) => { res.statusCode = 500; res.end("booting"); }).listen(${port}, "127.0.0.1");
`,
  );
  await assert.rejects(
    withAppServer({ command: app.command, health: `http://127.0.0.1:${port}/`, startup_timeout_ms: 1_000 }, async () => {
      assert.fail("must not run");
    }, { cwd: app.dir }),
    /did not answer/,
  );
  assert.ok(await gone(app.pids()));
});

test("server: gets SIGTERM first and may shut down cleanly before anything is forced", async () => {
  const port = await freePort();
  const app = appFiles(port);
  const marker = join(app.dir, "clean-shutdown");
  writeFileSync(
    join(app.dir, "server.mjs"),
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(app.dir, "server.pid"))}, String(process.pid));
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(marker)}, "bye"); process.exit(0); });
createServer((req, res) => res.end("ok")).listen(${port}, "127.0.0.1");
`,
  );
  await withAppServer({ command: app.command, health: `http://127.0.0.1:${port}/` }, async () => {}, { cwd: app.dir });
  assert.ok(existsSync(marker), "the server saw SIGTERM");
  assert.ok(await gone(app.pids()));
});

test("server: one that ignores SIGTERM is killed after the grace period", async () => {
  const port = await freePort();
  const app = appFiles(port);
  stubborn(app, port);
  await withAppServer({ command: app.command, health: `http://127.0.0.1:${port}/` }, async () => {}, { cwd: app.dir });
  assert.ok(await gone(app.pids()), "killed although it ignored SIGTERM");
});

test("server: process.exit() in the middle of the work still stops the server", async () => {
  const port = await freePort();
  const app = appFiles(port);
  const script = join(app.dir, "exit.mjs");
  writeFileSync(
    script,
    `import { withAppServer } from ${JSON.stringify(APP_SERVER)};
await withAppServer({ command: "node wrapper.mjs", health: "http://127.0.0.1:${port}/" }, async () => {
  process.exit(7);
}, { cwd: ${JSON.stringify(app.dir)} });
`,
  );
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const code = await new Promise((done) => child.once("exit", done));
  assert.equal(code, 7);
  assert.ok(await gone(app.pids()), "server tree gone after process.exit");
});

test("server: SIGTERM to visual-qa itself still stops the server (abort mid-run)", async () => {
  const port = await freePort();
  const app = appFiles(port);
  const script = join(app.dir, "abort.mjs");
  writeFileSync(
    script,
    `import { withAppServer } from ${JSON.stringify(APP_SERVER)};
await withAppServer({ command: "node wrapper.mjs", health: "http://127.0.0.1:${port}/" }, async () => {
  process.kill(process.pid, "SIGTERM");
  await new Promise((done) => setTimeout(done, 30_000));
}, { cwd: ${JSON.stringify(app.dir)} });
`,
  );
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const code = await new Promise((done) => child.once("exit", (exitCode, signal) => done(signal ?? exitCode)));
  assert.equal(code, "SIGTERM");
  assert.ok(await gone(app.pids()), "server tree gone after the abort");
});

test("agent-run: a server that does not start ends with exit 2, names why, and leaves nothing running", () => {
  const dir = mkdtempSync(join(tmpdir(), "vqa-cli-"));
  const git = (...args) =>
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "App.tsx"), "export const a = 1;\n");
  writeFileSync(
    join(dir, ".visual-qa.yml"),
    'route_map:\n  "src/**":\n    - /\nserver:\n  command: node -e "console.error(\'boom\'); process.exit(3)"\n  health: http://127.0.0.1:9/\n',
  );
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, "src", "App.tsx"), "export const a = 2;\n");
  const result = spawnSync(process.execPath, [CLI, "agent-run", "--out", join(dir, "out")], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /server exited \(code 3\) before http:\/\/127\.0\.0\.1:9\/ answered[\s\S]*boom/);
  assert.ok(!existsSync(join(dir, "out", "report.json")), "no report from a run that never started");
});

/** Run withAppServer in its own process, send `signal` once the work has started (plus `after` ms), report how it ended. */
async function abortedBy(signal, { hold, after }) {
  const port = await freePort();
  const app = appFiles(port);
  stubborn(app, port);
  const script = join(app.dir, "abort.mjs");
  writeFileSync(
    script,
    `import { withAppServer } from ${JSON.stringify(APP_SERVER)};
await withAppServer({ command: "node wrapper.mjs", health: "http://127.0.0.1:${port}/" }, async () => {
  console.log("work started");
  ${hold ? "await new Promise((done) => setTimeout(done, 60_000));" : ""}
}, { cwd: ${JSON.stringify(app.dir)} });
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  const ended = new Promise((done) => child.once("exit", (code, sig) => done(sig ?? code)));
  await new Promise((started) => child.stdout.on("data", (chunk) => String(chunk).includes("work started") && started()));
  await new Promise((wait) => setTimeout(wait, after));
  child.kill(signal);
  const how = await Promise.race([ended, new Promise((late) => setTimeout(() => late("no end"), 15_000))]);
  const stopped = await gone(app.pids());
  for (const pid of app.pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  if (how === "no end") child.kill("SIGKILL");
  return { how, stopped };
}

test("server: a second Ctrl-C, SIGTERM, SIGHUP, SIGQUIT or SIGUSR2 while the server is being stopped still takes it down", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR2"]) {
    // the work is done, SIGTERM went to a server that ignores it, the grace period is running
    const result = await abortedBy(signal, { hold: false, after: 600 });
    assert.deepEqual(result, { how: signal, stopped: true }, `${signal} during the grace period`);
  }
});

test("server: SIGHUP (terminal closed) in the middle of the work stops the server", async () => {
  const result = await abortedBy("SIGHUP", { hold: true, after: 200 });
  assert.deepEqual(result, { how: "SIGHUP", stopped: true });
});

test("server: an address where something already listens is refused before anything is started, whatever it answers", async () => {
  const port = await freePort();
  const marker = join(mkdtempSync(join(tmpdir(), "vqa-busy-")), "started");
  const foreign = createHttpServer((req, res) => {
    res.statusCode = 404;
    res.end("foreign app");
  }).listen(port, "127.0.0.1");
  await new Promise((listening) => foreign.once("listening", listening));
  try {
    let ran = false;
    await assert.rejects(
      withAppServer(
        { command: `node -e "require('fs').writeFileSync('${marker}','1')"`, health: `http://127.0.0.1:${port}/` },
        async () => {
          ran = true;
        },
      ),
      /is taken before the server started: another process listens on that address/,
    );
    assert.equal(ran, false, "the work never ran against the foreign app");
    assert.equal(existsSync(marker), false, "the command was not even started");
  } finally {
    foreign.close();
  }
});

test("server: a health connection that is accepted but never answered ends at startup_timeout_ms", async () => {
  const port = await freePort();
  const app = appFiles(port);
  writeFileSync(
    join(app.dir, "server.mjs"),
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(app.dir, "server.pid"))}, String(process.pid));
createServer(() => {}).listen(${port}, "127.0.0.1");
`,
  );
  const script = join(app.dir, "hang.mjs");
  writeFileSync(
    script,
    `import { withAppServer } from ${JSON.stringify(APP_SERVER)};
try {
  await withAppServer({ command: "node wrapper.mjs", health: "http://127.0.0.1:${port}/", startup_timeout_ms: 1_000 }, async () => {}, { cwd: ${JSON.stringify(app.dir)} });
} catch (error) {
  console.log(error.message.split("\\n")[0]);
}
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  let printed = "";
  child.stdout.on("data", (chunk) => (printed += chunk));
  const started = Date.now();
  const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
  await new Promise((done) => child.once("exit", done));
  clearTimeout(timer);
  assert.match(printed, /did not answer within 1s/);
  assert.ok(Date.now() - started < 12_000, "the hung request did not hold the wait past its limit");
  assert.ok(await gone(app.pids()));
});

test("agent-run: a port someone else holds ends with exit 2 and a sentence, not a run against that app", async () => {
  const port = await freePort();
  const foreign = createHttpServer((req, res) => res.end("foreign app")).listen(port, "127.0.0.1");
  await new Promise((listening) => foreign.once("listening", listening));
  const dir = mkdtempSync(join(tmpdir(), "vqa-busy-cli-"));
  const git = (...args) =>
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "App.tsx"), "export const a = 1;\n");
  writeFileSync(
    join(dir, ".visual-qa.yml"),
    `route_map:\n  "src/**":\n    - /\nserver:\n  command: node -e "setInterval(() => {}, 1000)"\n  health: http://127.0.0.1:${port}/\n`,
  );
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, "src", "App.tsx"), "export const a = 2;\n");
  const child = spawn(process.execPath, [CLI, "agent-run", "--out", join(dir, "out")], { cwd: dir });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((done) => child.once("exit", done));
  foreign.close();
  assert.equal(code, 2, stderr);
  assert.match(stderr, /is taken before the server started/);
  assert.ok(!existsSync(join(dir, "out", "report.json")), "nothing was walked");
});

test("agent-run: a server.health without http:// is a config error at once, the server is never started", () => {
  const dir = mkdtempSync(join(tmpdir(), "vqa-health-"));
  const git = (...args) =>
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "App.tsx"), "export const a = 1;\n");
  const flag = join(dir, "started.flag");
  writeFileSync(
    join(dir, ".visual-qa.yml"),
    `route_map:\n  "src/**":\n    - /\nserver:\n  command: node -e "require('fs').writeFileSync('${flag}','1');setInterval(()=>{},1e9)"\n  health: localhost:5173/health\n`,
  );
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, "src", "App.tsx"), "export const a = 2;\n");
  const started = Date.now();
  const result = spawnSync(process.execPath, [CLI, "agent-run", "--out", join(dir, "out")], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /server\.health must be an http\(s\) URL/);
  assert.equal(existsSync(flag), false);
  assert.ok(Date.now() - started < 20_000, "no 60 s wait for a URL that cannot answer");
});

// ── Besitz der Adresse: TCP, nicht Antwortzeit ──

/** A command that proves it was started (writes `marker`) and then stays up. */
const marking = (marker) => `node -e "require('fs').writeFileSync('${marker}','1');setInterval(()=>{},1e9)"`;
const markerPath = () => join(mkdtempSync(join(tmpdir(), "vqa-marker-")), "started");

test("healthEndpoint: host and port of an http(s) URL, the scheme's default port, no brackets on IPv6, null for anything else", () => {
  assert.deepEqual(healthEndpoint("http://127.0.0.1:5173/x?y=1"), { host: "127.0.0.1", port: 5173 });
  assert.deepEqual(healthEndpoint("http://localhost/"), { host: "localhost", port: 80 });
  assert.deepEqual(healthEndpoint("https://example.test"), { host: "example.test", port: 443 });
  assert.deepEqual(healthEndpoint("http://[::1]:3000/"), { host: "::1", port: 3000 });
  for (const other of ["localhost:5173", "ftp://example.test:21/", "not a url", "http://", "http://localhost:abc/", "http://localhost:99999/", "https://:5173/"])
    assert.equal(healthEndpoint(other), null, other);
});

test("server: a foreign app whose first answer takes 3 s is refused at once, never run against", async () => {
  const port = await freePort();
  const marker = markerPath();
  let hits = 0;
  const foreign = createHttpServer((req, res) => setTimeout(() => res.end("foreign app"), hits++ === 0 ? 3_000 : 0)).listen(
    port,
    "127.0.0.1",
  );
  await new Promise((listening) => foreign.once("listening", listening));
  const started = Date.now();
  try {
    let ran = false;
    await assert.rejects(
      withAppServer({ command: marking(marker), health: `http://127.0.0.1:${port}/`, startup_timeout_ms: 8_000 }, async () => {
        ran = true;
      }),
      /is taken before the server started/,
    );
    assert.equal(ran, false, "the work never ran against the foreign app");
    assert.equal(existsSync(marker), false, "the command was not even started");
    assert.ok(Date.now() - started < 2_000, "refused before the slow answer would have come");
  } finally {
    foreign.close();
    foreign.closeAllConnections();
  }
});

test("server: an answer that comes after the own server has died is not taken for the own", async () => {
  const port = await freePort();
  // not there yet when the address is checked, listening by the first health request, slow to answer
  const foreign = createHttpServer((req, res) => setTimeout(() => res.end("foreign app"), 1_500));
  const late = setTimeout(() => foreign.listen(port, "127.0.0.1"), 100);
  let ran = false;
  try {
    await assert.rejects(
      withAppServer(
        { command: `node -e "setTimeout(() => process.exit(3), 900)"`, health: `http://127.0.0.1:${port}/`, startup_timeout_ms: 8_000 },
        async () => {
          ran = true;
        },
      ),
      /server exited \(code 3\) before .* answered/,
    );
    assert.equal(ran, false, "the work never ran against the foreign app");
  } finally {
    clearTimeout(late);
    foreign.close();
    foreign.closeAllConnections();
  }
});

test("server: an address that swallows connections without taking them does not hold the start for longer than a second", async (t) => {
  const port = await freePort();
  // a process that listens with a backlog of 1 and never accepts: once the queue is full, new connects hang
  const jammed = spawn(
    process.execPath,
    [
      "-e",
      `require("net").createServer().listen({ port: ${port}, host: "127.0.0.1", backlog: 1 }, () => { console.log("up"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const fillers = [];
  try {
    await new Promise((up) => jammed.stdout.once("data", up));
    for (let n = 0; n < 8; n++) fillers.push(createConnection(port, "127.0.0.1").on("error", () => {}));
    await new Promise((settle) => setTimeout(settle, 300));
    const probe = createConnection(port, "127.0.0.1").on("error", () => {});
    const hangs = await Promise.race([
      new Promise((connected) => probe.once("connect", () => connected(false))),
      new Promise((waited) => setTimeout(() => waited(true), 600)),
    ]);
    probe.destroy();
    if (!hangs) return t.skip("this system accepts connections to a full queue, nothing to hang on");
    const marker = markerPath();
    const run = withAppServer({ command: marking(marker), health: `http://127.0.0.1:${port}/`, startup_timeout_ms: 500 }, async () => {}).then(
      () => "ran",
      (error) => error.message.split("\n")[0],
    );
    const waiting = Date.now();
    while (!existsSync(marker) && Date.now() - waiting < 8_000) await new Promise((tick) => setTimeout(tick, 50));
    assert.equal(existsSync(marker), true, "the check gave up and the command was started");
    assert.ok(Date.now() - waiting < 3_000, `the address check took ${Date.now() - waiting} ms`);
    assert.match(await run, /did not answer within/);
  } finally {
    for (const socket of fillers) socket.destroy();
    jammed.kill("SIGKILL");
  }
});

test("server: a health that is no http(s) URL is refused before anything is started", async () => {
  const marker = markerPath();
  await assert.rejects(
    withAppServer({ command: marking(marker), health: "localhost:5173/health", startup_timeout_ms: 500 }, async () => assert.fail("must not run")),
    /health "localhost:5173\/health" is no http\(s\) URL/,
  );
  assert.equal(existsSync(marker), false, "the command was not started");
});

test("server: a command that cannot be started at all is named at once, not waited for", async () => {
  const started = Date.now();
  await assert.rejects(
    withAppServer({ command: "true", health: "http://127.0.0.1:9/", startup_timeout_ms: 30_000 }, async () => assert.fail("must not run"), {
      cwd: join(tmpdir(), "vqa-no-such-folder"),
    }),
    /server could not start: spawn .*ENOENT/,
  );
  assert.ok(Date.now() - started < 10_000);
});
