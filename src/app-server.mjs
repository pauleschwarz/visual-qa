// visual-qa app server: start the project's own server, wait for its health URL, always stop it.
// Only the process group visual-qa spawned is ever signalled — never a match by name or port.

import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const GRACE_MS = 3_000;
const TAIL_CHARS = 2_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Signal the whole group the shell started (npm → node …). A group that is gone is fine; macOS
 * answers EPERM for one that only has zombies left. Cleanup never throws over the real error.
 */
function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

async function waitForHealth(health, state, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  const tail = () => (output.text.trim() ? `\n--- server output (tail) ---\n${output.text.trim()}` : "");
  for (;;) {
    if (state.failed) throw new Error(`server could not start: ${state.failed.message}${tail()}`);
    if (state.exited) throw new Error(`server exited (${state.exited}) before ${health} answered${tail()}`);
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline)
      throw new Error(`${health} did not answer within ${Math.round(timeoutMs / 1000)}s${tail()}`);
    await sleep(POLL_MS);
  }
}

/**
 * Run `fn` while `server.command` serves `server.health`. The server is stopped when `fn`
 * returns, throws, the health wait fails, or visual-qa itself gets SIGINT/SIGTERM.
 */
export async function withAppServer(server, fn, { cwd = process.cwd(), env = process.env } = {}) {
  const timeoutMs = server.startup_timeout_ms ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const output = { text: "" };
  const child = spawn(server.command, {
    cwd,
    env,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { exited: null, failed: null };
  const exited = new Promise((done) => {
    child.once("exit", (code, signal) => {
      state.exited = signal ?? `code ${code}`;
      done();
    });
    child.once("error", (error) => {
      state.failed = error;
      done();
    });
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output.text = (output.text + chunk).slice(-TAIL_CHARS);
    });

  const killNow = () => signalGroup(child.pid, "SIGKILL");
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => {
      release();
      killNow();
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
    return [signal, handler];
  });
  process.once("exit", killNow);
  function release() {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    process.removeListener("exit", killNow);
  }

  try {
    await waitForHealth(server.health, state, timeoutMs, output);
    return await fn();
  } finally {
    release();
    signalGroup(child.pid, "SIGTERM");
    await Promise.race([exited, sleep(GRACE_MS)]);
    killNow();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
