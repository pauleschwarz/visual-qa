import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { withAppServer } from "../src/app-server.mjs";

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
