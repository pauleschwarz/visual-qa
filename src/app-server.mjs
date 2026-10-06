// visual-qa app server: start the project's own server, wait for its health URL, always stop it.
// Only the process group visual-qa spawned is ever signalled — never a match by name or port.

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const GRACE_MS = 3_000;
const TAIL_CHARS = 2_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Every signal whose default is to end visual-qa on the spot; each one takes the server down first.
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR2"];

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

/** One health request: the response, whatever its status, or null when nothing answers within 2 s. */
async function ask(health) {
  try {
    return await fetch(health, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return null;
  }
}

/** Host and port an http(s) health URL points at (http 80, https 443), or null for anything else. */
export function healthEndpoint(health) {
  try {
    const url = new URL(health);
    if (!/^https?:$/.test(url.protocol)) return null;
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
  } catch {
    return null;
  }
}

/** True when something takes a TCP connection at `endpoint` — however long it would take to answer HTTP. */
function listening(endpoint) {
  return new Promise((done) => {
    const socket = net.connect({ ...endpoint, signal: AbortSignal.timeout(1_000) });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function waitForHealth(health, state, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  const tail = () => (output.text.trim() ? `\n--- server output (tail) ---\n${output.text.trim()}` : "");
  const stillAlive = () => {
    if (state.failed) throw new Error(`server could not start: ${state.failed.message}${tail()}`);
    if (state.exited) throw new Error(`server exited (${state.exited}) before ${health} answered${tail()}`);
  };
  for (;;) {
    stillAlive();
    // An answer from an address whose own server is already gone is someone else's answer.
    if ((await ask(health))?.ok) {
      stillAlive();
      return;
    }
    if (Date.now() >= deadline)
      throw new Error(`${health} did not answer within ${Math.round(timeoutMs / 1000)}s${tail()}`);
    await sleep(POLL_MS);
  }
}

/**
 * Run `fn` while `server.command` serves `server.health`. The server is stopped when `fn`
 * returns, throws, the health wait fails, or visual-qa itself gets one of STOP_SIGNALS —
 * also while it is being stopped. An address where something already listens before the start
 * belongs to someone else, even one that answers slowly: refused, never run against.
 */
export async function withAppServer(server, fn, { cwd = process.cwd(), env = process.env } = {}) {
  const timeoutMs = server.startup_timeout_ms ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const endpoint = healthEndpoint(server.health);
  if (!endpoint) throw new Error(`health "${server.health}" is no http(s) URL`);
  if (await listening(endpoint))
    throw new Error(
      `${server.health} is taken before the server started: another process listens on that address (stop it, or change the port in server.command and server.health)`,
    );
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
  const handlers = STOP_SIGNALS.map((signal) => {
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
    // The handlers stay until the group is dead: a second Ctrl-C or a hang-up during the
    // grace period must still take the server down, not leave it behind.
    signalGroup(child.pid, "SIGTERM");
    await Promise.race([exited, sleep(GRACE_MS)]);
    killNow();
    release();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
