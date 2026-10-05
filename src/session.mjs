// Visual QA - app sessions and named states.
//
// An app is rarely reachable as an anonymous visitor only. This module lets a
// project describe how to get into a state (sign in, seed storage, stub a
// route, break an API) and captures that state with the same mechanical checks
// as any explored page, plus an image and the visible text for review.

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserRuntime } from "./browser.mjs";
import { redact } from "./config.mjs";
import {
  dedupeIssues,
  issue,
  runA11y,
  runLayoutChecks,
  runRuntimeChecks,
  runScrollChecks,
} from "./checks.mjs";
import { runSlopChecks } from "./slop.mjs";

/** A project's own setup is wrong (missing file, throwing hook). Blocks the run (exit 2); never a product finding. */
export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupError";
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function importProjectModule(file, label) {
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    throw new SetupError(
      `${label} ${file} failed to load: ${error.message.split("\n")[0]}`,
    );
  }
}

export function fileSafe(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(-80);
}

const ERROR_STATUS = (value) =>
  Number.isInteger(value) && value >= 400 && value <= 599;

function normalizeExpectApi(name, def) {
  const merged = {};
  for (const key of ["fail_api", "expect_api"]) {
    const value = def[key];
    if (value === undefined) continue;
    // `expect_api: 500` or an empty block would inject nothing and let the state pass untested.
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length)
      throw new SetupError(
        `state "${name}": ${key} must map a URL glob to an HTTP error status or "timeout" (for example "**/api/orders": 500); received ${JSON.stringify(value) ?? "nothing"}`,
      );
    Object.assign(merged, value);
  }
  for (const [glob, how] of Object.entries(merged)) {
    if (how !== "timeout" && !ERROR_STATUS(how))
      throw new SetupError(
        `state "${name}": expect_api "${glob}" must be an HTTP error status (400-599) or "timeout"; received ${JSON.stringify(how)}`,
      );
  }
  return merged;
}

/**
 * Turn the project config (.visual-qa.yml) plus the names chosen on the
 * command line into what explore() consumes. Everything that can be wrong in
 * the project's own files is reported here, before any browser starts.
 */
export async function resolveSessionInput(
  config,
  { baseDir, states = [], journeys = [] } = {},
) {
  const session = { setup: null, storageState: null };
  let setupModule = null;
  if (config.setup) {
    session.setup = resolve(baseDir, config.setup);
    if (!(await exists(session.setup)))
      throw new SetupError(`setup file not found: ${session.setup}`);
    setupModule = await importProjectModule(session.setup, "setup file");
    if (typeof setupModule.setup !== "function")
      throw new SetupError(
        `setup file ${session.setup} must export a function setup(page, ctx)`,
      );
  }
  if (config.storage_state) {
    session.storageState = resolve(baseDir, config.storage_state);
    if (!(await exists(session.storageState)))
      throw new SetupError(
        `storage_state file not found: ${session.storageState}`,
      );
    try {
      JSON.parse(await readFile(session.storageState, "utf8"));
    } catch (error) {
      throw new SetupError(
        `storage_state file ${session.storageState} is not valid JSON: ${error.message}`,
      );
    }
  }

  const stateDefs = {};
  for (const selector of states) {
    const { name, path } = parseStateSelector(selector);
    const def = config.states?.[name];
    if (!def) throw new SetupError(unknownName("state", name, config.states));
    const statePath = path ?? def.path;
    if (typeof statePath !== "string" || !statePath.trim())
      throw new SetupError(`state "${name}" needs a path`);
    if (def.setup !== undefined) {
      if (typeof setupModule?.[def.setup] !== "function")
        throw new SetupError(
          `state "${name}": setup "${def.setup}" is not an exported function of ${session.setup ?? "a setup file (none configured)"}`,
        );
    }
    stateDefs[selector] = {
      path: statePath.trim(),
      setup: def.setup ?? null,
      fresh: def.fresh === true,
      reason: def.reason == null ? null : String(def.reason),
      expectApi: normalizeExpectApi(name, def),
    };
  }

  const journeyList = [];
  for (const name of journeys) {
    const entry = config.journeys?.[name];
    if (!entry)
      throw new SetupError(unknownName("journey", name, config.journeys));
    const file = typeof entry === "string" ? entry : entry.file;
    if (typeof file !== "string" || !file.trim())
      throw new SetupError(`journey "${name}" needs a file`);
    const abs = resolve(baseDir, file);
    if (!(await exists(abs)))
      throw new SetupError(`journey "${name}": file not found: ${abs}`);
    const module = await importProjectModule(abs, `journey "${name}"`);
    if (typeof module.default !== "function")
      throw new SetupError(
        `journey "${name}": ${abs} must export default async function ({ step, check })`,
      );
    journeyList.push({
      name,
      file: abs,
      fresh: typeof entry === "object" && entry.fresh === true,
    });
  }
  return { session, stateDefs, journeys: journeyList };
}

/** "name" or "/path@name": the same state definition, optionally on another path. */
export function parseStateSelector(selector) {
  const at = String(selector).lastIndexOf("@");
  return at < 0
    ? { name: String(selector), path: null }
    : { name: selector.slice(at + 1), path: selector.slice(0, at) || null };
}

/** Split route_map routes into plain paths and "path@state" selectors of defined states. */
export function splitStateRoutes(routes, definedStates = {}) {
  const plain = [];
  const states = [];
  for (const route of routes) {
    const { name } = parseStateSelector(route);
    (route.includes("@") && name in definedStates ? states : plain).push(route);
  }
  return { plain, states };
}

function unknownName(kind, name, defined) {
  const known = Object.keys(defined ?? {});
  return `unknown ${kind} "${name}"; ${known.length ? `known: ${known.join(", ")}` : `no ${kind}s defined in the config`}`;
}

/**
 * Context options and a before-navigation hook for BrowserRuntime. Order:
 * storage_state, global setup(page, ctx), the state's own setup, then the
 * injected API failures (last, so they win over setup stubs).
 */
export function sessionHooks({ session, def = null, ctx, expected = [] }) {
  const fresh = def?.fresh === true;
  const expectApi = def?.expectApi ?? {};
  const use = !fresh && session;
  const needsHook =
    (use && session.setup) || def?.setup || Object.keys(expectApi).length;
  return {
    storageState: use ? session.storageState : null,
    prepare: needsHook
      ? async (page) => {
          try {
            if (use && session.setup) {
              const module = await importProjectModule(
                session.setup,
                "setup file",
              );
              await module.setup(page, ctx);
            }
            if (def?.setup) {
              const module = await importProjectModule(
                session.setup,
                "setup file",
              );
              await module[def.setup](page, ctx);
            }
          } catch (error) {
            if (error instanceof SetupError) throw error;
            throw new SetupError(
              `setup failed${ctx.state ? ` for state "${ctx.state}"` : ""}: ${String(error?.message ?? error).split("\n")[0]}`,
            );
          }
          await installFailures(page, expectApi, expected);
        }
      : null,
  };
}

async function installFailures(page, expectApi, expected) {
  for (const [glob, how] of Object.entries(expectApi)) {
    await page.route(glob.startsWith("/") ? `**${glob}` : glob, (route) => {
      expected.push({ url: route.request().url(), glob, how });
      if (how === "timeout") return route.abort("timedout");
      return route.fulfill({
        status: how,
        contentType: "application/json",
        body: JSON.stringify({ error: "injected by visual-qa expect_api" }),
      });
    });
  }
}

/** Events caused by an injected failure are the point of the state, not findings. */
export function withoutExpectedFailures(events, expected) {
  if (!expected.length) return events;
  // The runtime stores redacted urls; match on the same form.
  const urls = new Set(expected.map((item) => redact(item.url)));
  return {
    ...events,
    network: (events.network ?? []).filter((item) => !urls.has(item.url)),
    // Chromium logs injected failures as "Failed to load resource" without a URL.
    console: (events.console ?? []).filter(
      (item) => !/Failed to load resource/i.test(item.text ?? ""),
    ),
  };
}

/** One browser for a state or journey run: the project's session hooks plus the run's timing. */
export function sessionRuntime(config, viewport, hooks) {
  return new BrowserRuntime({
    baseUrl: config.baseUrl,
    viewport,
    trace: false,
    outDir: config.outDir,
    stableFrames: config.stable_frames,
    stableGap: config.stable_gap_ms,
    navigationTimeout: config.navigation_timeout_ms,
    ...hooks,
  });
}

export function newWalk(viewport) {
  return {
    viewport: viewport.name,
    complete: true,
    limitReason: null,
    states: [],
    edges: [],
    issues: [],
    evidence: [],
    actions: 0,
  };
}

export async function visibleText(page) {
  return page
    .evaluate(() => document.body?.innerText || "")
    .then((text) => text.replace(/\r/g, "").trim())
    .catch(() => "");
}

/** Image plus the text a reader sees, side by side: `<base>.png` and `<base>.txt`. */
export async function writeShot(runtime, base) {
  await runtime.screenshot(`${base}.png`, { fullPage: true });
  const text = await visibleText(runtime.page);
  await writeFile(`${base}.txt`, `${text}\n`);
  return { screenshot: `${base}.png`, text: `${base}.txt`, content: text };
}

/**
 * What a reader can see and use on the page: the text of visible alert/status
 * regions and the focusable controls of the content area (header, nav, footer
 * and aside controls exist on every page and are left out).
 */
export async function readErrorSignals(page) {
  return page.evaluate(() => {
    const shown = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        !el.closest("[hidden],[aria-hidden='true'],[inert]")
      );
    };
    const squash = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const content = document.querySelector("main,[role=main]") ?? document.body;
    const alerts = [
      ...document.querySelectorAll(
        "[role=alert],[role=status],[aria-live]:not([aria-live=off])",
      ),
    ]
      .filter(shown)
      .map((el) => squash(el.innerText))
      .filter(Boolean);
    const controls = [
      ...content.querySelectorAll(
        "a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]",
      ),
    ]
      .filter(
        (el) =>
          !el.disabled &&
          el.tabIndex >= 0 &&
          shown(el) &&
          !el.closest("header,nav,footer,aside"),
      )
      .map((el) =>
        [
          el.tagName,
          el.getAttribute("href") ?? "",
          squash(el.innerText || el.getAttribute("aria-label") || el.value || el.title),
        ].join("|"),
      );
    return { text: squash(document.body?.innerText), alerts, controls };
  });
}

/**
 * An error state owes the reader two things: why, and where to go next - and
 * only what the failure added counts. `healthy` is the same state without the
 * injected failure: an alert region or a link that is on the healthy page too
 * is not the page reacting to the failure.
 */
export function judgeErrorState(seen, healthy, reason) {
  const hasReason = reason
    ? seen.text.toLowerCase().includes(String(reason).toLowerCase())
    : seen.alerts.some((alert) => !healthy.alerts.includes(alert));
  const hasWayForward = seen.controls.some(
    (control) => !healthy.controls.includes(control),
  );
  return { hasReason, hasWayForward };
}

/** Open a state's path and let it settle. */
async function openState(runtime, config, path) {
  await runtime.navigate(new URL(path, config.baseUrl).href);
  await runtime.page
    .waitForLoadState("networkidle", { timeout: 3_000 })
    .catch(() => {});
  await runtime.waitForStableState({
    frames: config.stable_frames,
    gap: config.stable_gap_ms,
  });
}

/** The same state without the injected failure: what the page shows when nothing is wrong. */
async function readHealthySignals({ config, viewport, def, ctx }) {
  const runtime = sessionRuntime(
    config,
    viewport,
    sessionHooks({
      session: config.session,
      def: { ...def, expectApi: {} },
      ctx,
    }),
  );
  try {
    await runtime.start();
    await openState(runtime, config, def.path);
    return await readErrorSignals(runtime.page);
  } finally {
    await runtime.stop();
  }
}

async function captureOne({ config, viewport, name, def, walk }) {
  const base = join(
    config.outDir,
    "screenshots",
    `appstate-${fileSafe(name)}-${fileSafe(viewport.name)}`,
  );
  const ctx = {
    baseUrl: config.baseUrl,
    // The state's name, also when it was picked as "/path@name"; `name` itself is the selector.
    state: parseStateSelector(name).name,
    viewport,
    locale: "en-US",
  };
  const expected = [];
  const hooks = sessionHooks({ session: config.session, def, ctx, expected });
  const runtime = sessionRuntime(config, viewport, hooks);
  const where = { state: name, viewport: viewport.name, path: def.path };
  try {
    await runtime.start();
    const end = runtime.markStep(`state:${name}`);
    await openState(runtime, config, def.path);
    const shot = await writeShot(runtime, base);
    const stateId = `app-state:${name}`;
    walk.states.push({
      state_id: stateId,
      name,
      kind: "app_state",
      url: runtime.page.url(),
      viewport: viewport.name,
    });
    walk.evidence.push({
      kind: "state_scan",
      state_id: stateId,
      viewport: viewport.name,
      screenshot: shot.screenshot,
      text: shot.text,
    });
    const page = runtime.page;
    walk.issues.push(
      ...(await runA11y(page)),
      ...(await runLayoutChecks(page, viewport)),
      ...(await runScrollChecks(page, viewport)),
    );
    if (config.slopChecks !== false)
      walk.issues.push(...(await runSlopChecks(page, { viewport })));
    walk.issues.push(
      ...(await runRuntimeChecks({
        ...withoutExpectedFailures(end(), expected),
        baseUrl: config.baseUrl,
      })),
    );
    const evidence = { ...where, screenshot: shot.screenshot, text: shot.text };
    if (Object.keys(def.expectApi).length) {
      if (!expected.length)
        walk.issues.push(
          issue(
            "state",
            `Injected failure never requested in state ${name}`,
            "low",
            `State "${name}" expects ${Object.keys(def.expectApi).join(", ")} to fail, but the page never requested it; the error state was not exercised.`,
            evidence,
          ),
        );
      else {
        const seen = judgeErrorState(
          await readErrorSignals(page),
          await readHealthySignals({ config, viewport, def, ctx }),
          def.reason,
        );
        if (!seen.hasReason)
          walk.issues.push(
            issue(
              "state",
              `Error state ${name} shows no reason`,
              "medium",
              def.reason
                ? `State "${name}" does not show the expected text "${def.reason}".`
                : `State "${name}" fails an API call but shows no alert or status text that the healthy page lacks; the user cannot tell what went wrong.`,
              evidence,
            ),
          );
        if (!seen.hasWayForward)
          walk.issues.push(
            issue(
              "state",
              `Error state ${name} offers no way forward`,
              "medium",
              `State "${name}" fails an API call but its content area has no focusable control that the healthy page lacks (retry, back, link); the user is stuck.`,
              evidence,
            ),
          );
      }
    }
  } catch (error) {
    if (error instanceof SetupError) throw error;
    walk.complete = false;
    walk.limitReason ||= "state_error";
    walk.issues.push(
      issue(
        "state",
        `State ${name} could not be captured`,
        "high",
        `State "${name}" (${def.path}) failed on ${viewport.name}: ${String(error?.message ?? error).split("\n")[0]}`,
        where,
      ),
    );
  } finally {
    await runtime.stop();
  }
}

/**
 * Capture every selected state once per viewport. Returns walk-shaped
 * results so explore() can aggregate them like exploration walks.
 */
export async function captureStates(config, { started, budget }) {
  await mkdir(join(config.outDir, "screenshots"), { recursive: true });
  const walks = [];
  for (const viewport of config.viewports) {
    const walk = newWalk(viewport);
    for (const [name, def] of Object.entries(config.stateDefs)) {
      if (Date.now() - started > config.bounds.max_runtime_ms) {
        walk.complete = false;
        walk.limitReason ||= "max_runtime_ms";
        break;
      }
      await captureOne({ config, viewport, name, def, walk });
      budget.states += 1;
    }
    walk.issues = dedupeIssues(walk.issues);
    walks.push(walk);
  }
  return walks;
}
