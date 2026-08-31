// Visual QA - bounded deterministic state-graph explorer.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserRuntime } from "./browser.mjs";
import { classifyRisk, RISK, redact, resolveConfig } from "./config.mjs";
import {
  compareScreenshots,
  dedupeIssues,
  runA11y,
  runLayoutChecks,
  runRuntimeChecks,
  runScrollChecks,
  verdictFor,
} from "./checks.mjs";
import {
  buildState,
  normalizeUrl,
  sameOrigin,
  scrubVolatile,
} from "./state.mjs";
import { runSlopChecks } from "./slop.mjs";
import { runSecurityChecks } from "./security.mjs";

// Budgets that end the whole walk, as opposed to node-local truncations.
const GLOBAL_LIMITS = new Set([
  "max_runtime_ms",
  "max_states",
  "max_total_actions",
]);

function now() {
  return Date.now();
}
function actionId(stateId, control, index) {
  return `${stateId}:${control.role}:${scrubVolatile(control.name)}:${control.href || ""}:${index}`;
}
function semanticIssue({ control, expectation, observation, url }) {
  const title =
    expectation === "navigation"
      ? "Navigation action did not navigate"
      : "Action produced no observable result";
  return {
    issue_id: `vqa-functional-${control.role}-${scrubVolatile(control.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 42)}`,
    type: "vqa-functional",
    title,
    severity: "high",
    detail: `${control.role} '${control.name || "unnamed"}' executed but expectation '${expectation}' was not observed.`,
    evidence: redact({ control, expectation, observation, url }),
  };
}

function expectedFor(control) {
  if (control.role === "link" && control.href && !control.href.startsWith("#"))
    return "navigation";
  if (control.role === "tab") return "content-change";
  if (["checkbox", "radio", "switch"].includes(control.role))
    return "value-change";
  if (["textbox", "searchbox", "combobox"].includes(control.role))
    return "input-or-validation";
  return "content-change";
}

function changed(before, after) {
  // Snapshots carry identity under .state; reading .state_id off the snapshot
  // is always undefined and silently disables same-document change detection.
  return (
    before.state.state_id !== after.state.state_id ||
    before.url !== after.url ||
    before.text !== after.text
  );
}

async function snapshot(runtime, config) {
  // Every probe is an independent CDP round-trip; running them sequentially
  // cost seconds per step. They observe the same settled page, so issue them
  // together and let the driver pipeline them.
  const url = runtime.page.url();
  const [controls, aria, theme, headings, dialogOpen, dom, text, focus] =
    await Promise.all([
      runtime.inventory(),
      runtime.ariaSnapshot(),
      runtime.themeSignal(),
      runtime.headings(),
      runtime.dialogOpen(),
      runtime.domSnapshot(),
      runtime.visibleText(),
      runtime.focusSnapshot(),
    ]);
  const state = buildState({
    url,
    baseUrl: config.baseUrl,
    aria,
    headings,
    controls,
    dialogOpen,
    viewport: runtime.viewport.name,
    theme,
  });
  return { state, url, theme, controls, aria, dom, text, focus };
}

function controlKey(control) {
  return `${control.role}|${control.id || ""}|${scrubVolatile(control.name)}|${control.href || ""}`;
}

function controlSignalChanged(
  beforeControls = [],
  afterControls = [],
  control,
) {
  const key = controlKey(control);
  const before = beforeControls.find((item) => controlKey(item) === key);
  const after = afterControls.find((item) => controlKey(item) === key);
  if (!before || !after) return false;
  return (
    before.pressed !== after.pressed ||
    before.current !== after.current ||
    before.name !== after.name
  );
}

function alreadySatisfied(control) {
  // Active plate / selected tab / pressed toggle: re-click is a documented no-op.
  if (control.current === "true" || control.current === "page") return true;
  if (control.pressed === "true" && control.role === "button") return false;
  return false;
}

/**
 * Explore from one URL with a bounded BFS. Each action records expectation,
 * before/after semantic observations, screenshots, DOM/ARIA/focus, runtime
 * events, and the graph edge. New states are queued; known states are edges.
 * One walk covers exactly one viewport; runtime and action budgets live in the
 * shared `budget` so a multi-viewport run cannot multiply its own bounds.
 */
async function exploreViewport(config, viewport, budget) {
  // The per-viewport runtime bound is a SLICE of the run. Measuring it against
  // the global start made every viewport after the first exceed its budget on
  // the first check and report zero coverage.
  const started = now();
  const outDir = config.outDir;

  const runtime = await new BrowserRuntime({
    baseUrl: config.baseUrl,
    viewport,
    trace: config.trace,
    outDir,
    stableFrames: config.stable_frames,
    stableGap: config.stable_gap_ms,
    navigationTimeout: config.navigation_timeout_ms,
  }).start();
  const states = new Map();
  const scanned = new Set();
  const edges = [];
  const evidence = [];
  const issues = [];
  let actions = 0;
  let limitReason = null;
  let complete = true;

  try {
    const endBootEvents = runtime.markStep("boot");
    await runtime.navigate(config.baseUrl);
    const first = await snapshot(runtime, config);
    issues.push(...(await runA11y(runtime.page)));
    issues.push(...(await runLayoutChecks(runtime.page, viewport)));
    issues.push(...(await runScrollChecks(runtime.page, viewport)));
    // Slop heuristics describe a state like the other static checks.
    if (config.slopChecks !== false)
      issues.push(...(await runSlopChecks(runtime.page, { viewport })));
    // Security probes are mutating (storage reads, canary fills) and are
    // gated on the explicit isolated declaration, never inferred.
    if (config.isolatedEnvironment && config.securityChecks !== false)
      issues.push(
        ...(await runSecurityChecks({
          page: runtime.page,
          baseUrl: config.baseUrl,
          viewport,
        })),
      );
    // Load-time console/page/network failures must be able to fail a run; if
    // they are only collected inside the action loop they are dropped entirely.
    issues.push(
      ...(await runRuntimeChecks({
        ...endBootEvents(),
        baseUrl: config.baseUrl,
      })),
    );
    const queue = [{ snapshot: first, depth: 0 }];
    states.set(first.state.state_id, { ...first.state, depth: 0 });
    scanned.add(first.state.state_id);

    while (queue.length) {
      if (now() - started > config.bounds.max_runtime_ms) {
        complete = false;
        limitReason = "max_runtime_ms";
        break;
      }
      if (budget.states + states.size >= config.bounds.max_states) {
        complete = false;
        limitReason = "max_states";
        break;
      }
      const queued = queue.shift();
      if (queued.depth >= config.bounds.max_depth) {
        complete = false;
        limitReason ||= "max_depth";
        continue;
      }
      // Re-enter the queued state before branching. Without this, later nodes
      // run against a stale live page and invent false no-ops / timeouts.
      await runtime
        .restoreState({
          url: queued.snapshot.url,
          theme: queued.snapshot.theme,
        })
        .catch(() => {});
      const live = await snapshot(runtime, config);
      const current = {
        snapshot:
          live.state.state_id === queued.snapshot.state.state_id
            ? live
            : queued.snapshot,
        depth: queued.depth,
        live,
      };
      // Prefer live controls when restore landed on the intended state.
      const source =
        live.state.state_id === queued.snapshot.state.state_id
          ? live
          : queued.snapshot;
      const controls = source.controls.slice(
        0,
        config.bounds.max_actions_per_state,
      );
      if (source.controls.length > controls.length) {
        complete = false;
        limitReason ||= "max_actions_per_state";
      }

      for (let index = 0; index < controls.length; index++) {
        if (budget.actions + actions >= config.bounds.max_total_actions) {
          complete = false;
          limitReason = "max_total_actions";
          break;
        }
        if (now() - started > config.bounds.max_runtime_ms) {
          complete = false;
          limitReason = "max_runtime_ms";
          break;
        }
        // Keep the live page on this node between sibling actions.
        await runtime
          .restoreState({
            url: source.url,
            theme: source.theme,
          })
          .catch(() => {});
        const control = controls[index];
        const id = actionId(source.state.state_id, control, index);
        // External pages are outside the SUT. Do not follow them: otherwise
        // foreign DOM/a11y/runtime findings get attributed to this run and
        // consume the bounded exploration budget.
        if (
          control.role === "link" &&
          control.href &&
          !sameOrigin(control.href, config.baseUrl)
        ) {
          evidence.push({
            action_id: id,
            status: "skipped",
            skip_reason: "EXTERNAL_NAVIGATION",
            control,
          });
          continue;
        }
        // A link to the page it is already on cannot navigate: clicking it is
        // a documented no-op, not a dead control. Resolve against the live
        // page URL, not the state identity, since restoreState may have
        // landed on any same-document sibling of this state.
        if (control.role === "link" && control.href) {
          const liveUrl = runtime.page.url();
          try {
            const resolved = new URL(control.href, liveUrl);
            if (
              normalizeUrl(resolved.href, config.baseUrl) ===
              normalizeUrl(liveUrl, config.baseUrl)
            ) {
              evidence.push({
                action_id: id,
                status: "skipped",
                skip_reason: "SELF_NAVIGATION_NOOP",
                control,
              });
              continue;
            }
          } catch {
            // Malformed href: fall through and let the action report it.
          }
        }
        const risk = classifyRisk(control.name, control.tag);
        if (
          risk === RISK.DESTRUCTIVE ||
          (risk === RISK.MUTATING && !config.allowMutating)
        ) {
          evidence.push({
            action_id: id,
            status: "skipped",
            skip_reason: `${risk}_ACTION_NOT_ALLOWED`,
            control,
          });
          continue;
        }
        const expected = expectedFor(control);
        const before = await snapshot(runtime, config);
        // Skip decisions must read the LIVE control, not the queued snapshot:
        // after restoreState the page can already satisfy the control (e.g.
        // scroll position back at beat 0), and clicking it then looks like a
        // dead button when it is really a documented no-op.
        const liveControl =
          before.controls.find(
            (item) => controlKey(item) === controlKey(control),
          ) || control;
        if (alreadySatisfied(liveControl)) {
          evidence.push({
            action_id: id,
            status: "skipped",
            skip_reason: "ALREADY_SATISFIED",
            control: liveControl,
          });
          continue;
        }
        const stepStarted = now();
        const endEvents = runtime.markStep(id);
        const beforeShot = join(
          outDir,
          "screenshots",
          `${safe(id)}-before.png`,
        );
        const afterShot = join(outDir, "screenshots", `${safe(id)}-after.png`);
        const trace = join(outDir, "traces", `${safe(id)}.zip`);
        await runtime.screenshot(beforeShot, { stable: false }).catch(() => {});
        let status = "observed";
        let error = null;
        try {
          if (["textbox", "searchbox"].includes(control.role)) {
            await runtime.fill(
              control,
              control.type === "email" ? "qa@example.invalid" : "Visual QA",
            );
            await runtime.press("Tab");
          } else if (control.role === "combobox") {
            await (await runtime.locate(control))
              .press("ArrowDown")
              .catch(() => {});
            await runtime.press("Tab");
          } else {
            await runtime.click(control);
          }
          await runtime.waitForStableState({
            frames: config.stable_frames,
            gap: config.stable_gap_ms,
          });
        } catch (err) {
          status = "error";
          error = redact({ name: err.name, message: err.message });
          await runtime
            .restoreState({ url: before.url, theme: before.theme })
            .catch(() => {});
        }
        const after = await snapshot(runtime, config);
        await runtime.screenshot(afterShot, { stable: false }).catch(() => {});
        // Pixel evidence: a control may change only what is painted, and a
        // semantics-only oracle would report that as a dead control.
        const pixels = await compareScreenshots(beforeShot, afterShot).catch(
          () => null,
        );
        const eventDelta = endEvents();
        const observation = {
          url: after.url,
          url_changed:
            normalizeUrl(before.url, config.baseUrl) !==
            normalizeUrl(after.url, config.baseUrl),
          state_changed: changed(before, after),
          text_changed: before.text !== after.text,
          control_changed: controlSignalChanged(
            before.controls,
            after.controls,
            control,
          ),
          focus: after.focus,
          pixels_changed: pixels?.changed ?? null,
          pixel_ratio: pixels?.ratio ?? null,
          duration_ms: now() - stepStarted,
          status,
          error,
          ...eventDelta,
        };
        const expectedMet =
          status === "observed" &&
          (expected === "navigation"
            ? observation.url_changed || observation.state_changed
            : observation.state_changed ||
              observation.text_changed ||
              observation.url_changed ||
              observation.control_changed ||
              before.theme !== after.theme ||
              pixels?.changed === true);
        if (!expectedMet && status !== "error")
          issues.push(
            semanticIssue({
              control,
              expectation: expected,
              observation,
              url: before.url,
            }),
          );
        if (status === "error")
          issues.push({
            issue_id: `vqa-functional-action-${safe(id)}`,
            type: "vqa-functional",
            title: "Interactive action failed",
            severity: "high",
            detail: error?.message || "Playwright action failed",
            evidence: redact({ control, error }),
          });
        edges.push({
          from: before.state.state_id,
          to: after.state.state_id,
          action_id: id,
          expectation: expected,
          observation: redact(observation),
        });
        evidence.push(
          redact({
            action_id: id,
            state_id: before.state.state_id,
            control,
            expectation: expected,
            observation,
            before: {
              url: before.url,
              theme: before.theme,
              aria: before.aria,
              dom: before.dom,
              focus: before.focus,
              screenshot: beforeShot,
            },
            after: {
              url: after.url,
              theme: after.theme,
              aria: after.aria,
              dom: after.dom,
              focus: after.focus,
              screenshot: afterShot,
            },
            trace,
          }),
        );
        actions++;

        // Static checks describe a STATE, not an action. Re-sampling the whole
        // runway after every click multiplied runtime until runs timed out
        // without ever writing a report.
        if (!scanned.has(after.state.state_id)) {
          scanned.add(after.state.state_id);
          issues.push(...(await runA11y(runtime.page)));
          issues.push(...(await runLayoutChecks(runtime.page, viewport)));
          issues.push(...(await runScrollChecks(runtime.page, viewport)));
          if (config.slopChecks !== false)
            issues.push(...(await runSlopChecks(runtime.page, { viewport })));
        }
        issues.push(
          ...(await runRuntimeChecks(
            { ...eventDelta, baseUrl: config.baseUrl },
            eventDelta.pageErrors.length ||
              eventDelta.network.length ||
              eventDelta.console.some((event) => event.type === "error")
              ? [
                  {
                    issue_id: `vqa-runtime-step-${safe(id)}`,
                    type: "vqa-runtime",
                    title: "Runtime error during action",
                    severity: "high",
                    detail:
                      "Console, page, or network errors correlated with this action.",
                    evidence: redact(eventDelta),
                  },
                ]
              : [],
          )),
        );

        if (!states.has(after.state.state_id)) {
          states.set(after.state.state_id, {
            ...after.state,
            depth: current.depth + 1,
          });
          // URL + theme restore makes same-document states re-enterable.
          queue.push({ snapshot: after, depth: current.depth + 1 });
        }
        if (after.state.state_id !== before.state.state_id) {
          // Reset every branch to the node origin before the next sibling.
          await runtime
            .restoreState({ url: source.url, theme: source.theme })
            .catch(() => {});
        }
      }
      // Only global budgets end the walk. max_depth and max_actions_per_state
      // truncate a single node, so aborting the BFS on them would silently
      // strand queued states that are still within budget.
      if (GLOBAL_LIMITS.has(limitReason)) break;
    }

    // A full run needs evidence, not merely zero findings.
    if (!evidence.length) {
      complete = false;
      limitReason ||= "no_action_evidence";
    }
    budget.actions += actions;
    budget.states += states.size;
    return {
      viewport: viewport.name,
      complete,
      limitReason,
      states: [...states.values()],
      edges,
      issues,
      evidence,
      actions,
    };
  } finally {
    await runtime.stop(
      join(outDir, "traces", `run-${safe(viewport.name)}.zip`),
    );
  }
}

/**
 * Run one bounded walk per configured viewport and merge them into one report.
 * A viewport that is never walked is missing coverage, not a passing run.
 */
export async function explore(input = {}) {
  const config = resolveConfig(input);
  if (!config.baseUrl) throw new Error("Visual QA requires baseUrl");
  const started = now();
  const outDir = config.outDir;
  await mkdir(join(outDir, "screenshots"), { recursive: true });
  await mkdir(join(outDir, "traces"), { recursive: true });

  const budget = { actions: 0, states: 0 };
  const walks = [];
  for (const viewport of config.viewports) {
    // Reserve enough wall-clock budget for each declared viewport. A single
    // slow walk must not starve later viewport coverage.
    const remainingViewports = config.viewports.length - walks.length;
    const remainingMs = Math.max(
      1,
      config.bounds.max_runtime_ms - (now() - started),
    );
    const viewportConfig = {
      ...config,
      bounds: {
        ...config.bounds,
        max_runtime_ms: Math.min(
          config.bounds.max_runtime_ms,
          Math.ceil(remainingMs / remainingViewports),
        ),
      },
    };
    walks.push(await exploreViewport(viewportConfig, viewport, budget));
    if (now() - started > config.bounds.max_runtime_ms) break;
    if (budget.actions >= config.bounds.max_total_actions) break;
  }

  const covered = walks.map((walk) => walk.viewport);
  const missing = config.viewports
    .map((viewport) => viewport.name)
    .filter((name) => !covered.includes(name));
  const issues = dedupeIssues(walks.flatMap((walk) => walk.issues));
  const complete = walks.every((walk) => walk.complete) && !missing.length;
  const limitReason =
    walks.find((walk) => walk.limitReason)?.limitReason ||
    (missing.length ? "viewport_not_covered" : null);

  const result = {
    schema_version: "vqa-0.1",
    product: "Visual QA",
    mode: config.mode,
    verdict: verdictFor({ issues, complete, coverageReason: limitReason }),
    complete,
    coverage: {
      bounds: config.bounds,
      states: budget.states,
      actions: budget.actions,
      queued: 0,
      limit_reason: limitReason,
      viewports_covered: covered,
      viewports_missing: missing,
    },
    states: walks.flatMap((walk) => walk.states),
    edges: walks.flatMap((walk) => walk.edges),
    issues,
    evidence: walks.flatMap((walk) => walk.evidence),
    started_at: new Date(started).toISOString(),
    duration_ms: now() - started,
    config: redact({
      ...config,
      intent: config.intent ? "[configured]" : null,
    }),
  };
  await writeFile(
    join(outDir, "report.json"),
    `${JSON.stringify(redact(result), null, 2)}\n`,
    { mode: 0o600 },
  );
  return result;
}

function safe(input) {
  return String(input)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(-100);
}
