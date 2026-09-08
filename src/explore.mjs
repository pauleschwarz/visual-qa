// Visual QA - bounded deterministic state-graph explorer.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserRuntime, probeValueFor } from "./browser.mjs";
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
import { runIntentChecks } from "./intent.mjs";
import { writeReportArtifacts } from "./report.mjs";

// Budgets that end the whole walk, as opposed to node-local truncations.
const GLOBAL_LIMITS = new Set([
  "max_runtime_ms",
  "max_states",
  "max_total_actions",
]);

function now() {
  return Date.now();
}

/**
 * Explorer-mechanics failures are evidence, never silence: a swallowed
 * restore/screenshot/teardown error would let findings claim a page state
 * that was never actually reached.
 */
function explorerIssue(kind, title, severity, detail, evidence = {}) {
  return {
    issue_id: `vqa-${kind}-${String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60)}`,
    type: `vqa-${kind}`,
    title,
    severity,
    detail,
    evidence: redact(evidence),
  };
}

async function restoreOrIssue(runtime, target, issues, { severe } = {}) {
  try {
    await runtime.restoreState(target);
    return true;
  } catch (error) {
    issues.push(
      explorerIssue(
        "explorer",
        "State restore failed",
        severe ? "high" : "medium",
        "The explorer could not re-enter a page state; subsequent observations may describe the wrong page.",
        { target: redact(target), error: redact({ message: String(error) }) },
      ),
    );
    return false;
  }
}

async function screenshotOrIssue(
  runtime,
  path,
  issues,
  label,
  { fullPage = false } = {},
) {
  try {
    await runtime.screenshot(path, { stable: false, fullPage });
    return true;
  } catch (error) {
    issues.push(
      explorerIssue(
        "explorer",
        "Screenshot capture failed",
        "medium",
        `The ${label} screenshot could not be written; pixel evidence is incomplete.`,
        { path: String(path), error: redact({ message: String(error) }) },
      ),
    );
    return false;
  }
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
  if (
    ["textbox", "searchbox", "spinbutton", "slider", "combobox"].includes(
      control.role,
    )
  )
    return "input-or-validation";
  return "content-change";
}

const FILL_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);

/**
 * Drive one control the same way in live explore and SPA replay.
 * Never auto-submits forms — fill/Tab or click is enough.
 */
async function driveControl(runtime, control, { onSoftError } = {}) {
  if (FILL_ROLES.has(control.role)) {
    await runtime.fill(control, probeValueFor(control));
    await runtime.press("Tab");
    return;
  }
  if (control.role === "slider") {
    const value = probeValueFor(control);
    try {
      await runtime.fill(control, value);
    } catch {
      const locator = await runtime.locate(control);
      await locator.focus({ timeout: 1_500 });
      await runtime.press("ArrowRight");
    }
    await runtime.press("Tab");
    return;
  }
  if (control.role === "combobox") {
    if (control.tag === "select") {
      try {
        await runtime.selectFirstOption(control);
        await runtime.press("Tab");
        return;
      } catch (error) {
        onSoftError?.(error, "select");
      }
    }
    try {
      await (await runtime.locate(control)).press("ArrowDown");
    } catch (error) {
      onSoftError?.(error, "combobox");
    }
    await runtime.press("Tab");
    return;
  }
  // option / menuitem / checkbox / radio / switch / button / link / tab
  await runtime.click(control);
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

async function replayControl(runtime, control) {
  // Text-entry / input probes reconstruct via driveControl. Mutating or
  // destructive controls are never replayed into a queued SPA path.
  if (
    FILL_ROLES.has(control.role) ||
    control.role === "slider" ||
    control.role === "combobox"
  ) {
    await driveControl(runtime, control);
    return;
  }
  const risk = classifyRisk(control.name, control.tag, control.type);
  if (risk !== RISK.SAFE) {
    throw new Error(
      `unsafe replay step: ${risk} ${control.role} '${control.name || "unnamed"}'`,
    );
  }
  await driveControl(runtime, control);
}

async function captureStateScreenshot(
  runtime,
  outDir,
  stateId,
  viewport,
  issues,
  evidence,
) {
  const shot = join(
    outDir,
    "screenshots",
    `state-${safe(stateId)}-${safe(viewport?.name || "vp")}.png`,
  );
  const ok = await screenshotOrIssue(runtime, shot, issues, "state-scan", {
    fullPage: true,
  });
  if (ok) {
    evidence.push({
      kind: "state_scan",
      state_id: stateId,
      viewport: viewport?.name || null,
      screenshot: shot,
    });
  }
  return ok ? shot : null;
}

/** Rebuild a queued SPA state from its entry point and deterministic action path. */
async function reenterQueuedState(runtime, queued, config, issues) {
  const restored = await restoreOrIssue(
    runtime,
    { url: queued.entry.url, theme: queued.entry.theme },
    issues,
    { severe: true },
  );
  if (!restored) return { ok: false, snapshot: await snapshot(runtime, config) };
  try {
    for (const step of queued.path) await replayControl(runtime, step.control);
  } catch (error) {
    issues.push(
      explorerIssue(
        "explorer",
        "State action path replay failed",
        "high",
        "The explorer could not replay the actions required to re-enter a queued SPA state.",
        {
          target_state_id: queued.snapshot.state.state_id,
          path: queued.path.map((step) => step.control),
          error: { name: error?.name, message: error?.message },
        },
      ),
    );
    return { ok: false, snapshot: await snapshot(runtime, config) };
  }
  const live = await snapshot(runtime, config);
  if (live.state.state_id !== queued.snapshot.state.state_id) {
    issues.push(
      explorerIssue(
        "explorer",
        "State identity restore mismatch",
        "high",
        "The replayed action path reached a different UI state than the queued state.",
        {
          expected_state_id: queued.snapshot.state.state_id,
          actual_state_id: live.state.state_id,
          path: queued.path.map((step) => step.control),
        },
      ),
    );
    return { ok: false, snapshot: live };
  }
  return { ok: true, snapshot: live };
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
    before.valueState !== after.valueState ||
    before.checked !== after.checked ||
    before.selectedIndex !== after.selectedIndex ||
    before.name !== after.name
  );
}

function alreadySatisfied(control) {
  // Active plate / selected tab / pressed toggle: re-click is a documented no-op.
  if (control.current === "true" || control.current === "page") return true;
  if (control.pressed === "true" && control.role === "button") return false;
  return false;
}

function baselineMissing(baselineDir, viewportName) {
  return readFile(join(baselineDir, `${viewportName}.png`))
    .then(() => false)
    .catch(() => true);
}

/**
 * Explore from one URL with a bounded BFS. Each action records expectation,
 * before/after semantic observations, screenshots, DOM/ARIA/focus, runtime
 * events, and the graph edge. New states are queued; known states are edges.
 * One walk covers exactly one viewport; runtime and action budgets live in the
 * shared `budget` so a multi-viewport run cannot multiply its own bounds.
 */
async function exploreViewport(config, viewport, budget, entryUrls) {
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
  let walkResult = null;

  try {
    const endBootEvents = runtime.markStep("boot");
    const queue = [];
    // Each declared entry point is seeded as a root state so "changed" runs
    // cover exactly the declared targets instead of a full sweep.
    for (const entryUrl of entryUrls) {
      await runtime.navigate(entryUrl);
      const entry = await snapshot(runtime, config);
      if (states.has(entry.state.state_id)) continue;
      states.set(entry.state.state_id, {
        ...entry.state,
        url: entry.url,
        depth: 0,
      });
      queue.push({
        snapshot: entry,
        depth: 0,
        entry: { url: entry.url, theme: entry.theme },
        path: [],
      });
      scanned.add(entry.state.state_id);
      await captureStateScreenshot(
        runtime,
        outDir,
        entry.state.state_id,
        viewport,
        issues,
        evidence,
      );
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
      // Intent checks are read-only: computed styles must already satisfy the
      // parsed instruction. A mismatch here is the baseline that the verify
      // run has to clear.
      if (config.intentChecks?.length)
        issues.push(
          ...(await runIntentChecks(runtime.page, config.intentChecks, {
            viewport,
          })),
        );
    }
    if (queue.length === 0) {
      // Every declared entry collapsed into an unreachable or duplicate
      // state; a walk with no observable start cannot claim coverage.
      complete = false;
      limitReason = "no_entry_state";
    }
    // Baseline gate: a missing baseline is missing coverage, never a pass.
    if (
      config.baselineDir &&
      (await baselineMissing(config.baselineDir, viewport.name))
    ) {
      issues.push(
        explorerIssue(
          "baseline",
          "Baseline missing",
          "high",
          `No baseline screenshot for viewport '${viewport.name}'; render-regression coverage is incomplete.`,
          {
            viewport: viewport.name,
            baseline_path: join(config.baselineDir, `${viewport.name}.png`),
            reason: "baseline_missing",
          },
        ),
      );
      complete = false;
      limitReason ||= "baseline_missing";
    } else if (config.baselineDir) {
      const initialShot = join(
        outDir,
        "screenshots",
        `initial-${safe(viewport.name)}.png`,
      );
      if (await screenshotOrIssue(runtime, initialShot, issues, "initial")) {
        try {
          const comparison = await compareScreenshots(
            join(config.baselineDir, `${viewport.name}.png`),
            initialShot,
          );
          if (comparison.changed)
            issues.push(
              explorerIssue(
                "baseline",
                "Initial render differs from baseline",
                "medium",
                `The initial '${viewport.name}' render differs from the stored baseline screenshot.`,
                {
                  viewport: viewport.name,
                  pixel_ratio: comparison.ratio,
                  baseline_path: join(
                    config.baselineDir,
                    `${viewport.name}.png`,
                  ),
                },
              ),
            );
        } catch (error) {
          issues.push(
            explorerIssue(
              "baseline",
              "Baseline comparison failed",
              "medium",
              "The stored baseline could not be compared against the initial render.",
              {
                viewport: viewport.name,
                error: redact({ message: String(error) }),
              },
            ),
          );
        }
      }
    }
    // Load-time console/page/network failures must be able to fail a run; if
    // they are only collected inside the action loop they are dropped entirely.
    issues.push(
      ...(await runRuntimeChecks({
        ...endBootEvents(),
        baseUrl: config.baseUrl,
      })),
    );

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
      // Re-enter the exact queued state by replaying the path that created it.
      // URL+theme alone is insufficient for same-URL SPA states (dialogs,
      // selected tabs, expanded panels, filters).
      const reentered = await reenterQueuedState(
        runtime,
        queued,
        config,
        issues,
      );
      if (!reentered.ok) {
        complete = false;
        continue;
      }
      const live = reentered.snapshot;
      const current = {
        snapshot: live,
        depth: queued.depth,
        live,
        intended: queued.snapshot,
      };
      const controls = live.controls.slice(
        0,
        config.bounds.max_actions_per_state,
      );
      if (live.controls.length > controls.length) {
        complete = false;
        limitReason ||= "max_actions_per_state";
      }

      let liveIsCurrent = true;
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
        // Every sibling starts from the exact queued UI state. Replaying the
        // state path avoids acting on a root page after a prior sibling closed
        // a modal or otherwise mutated same-URL SPA state.
        if (index > 0) {
          const reset = await reenterQueuedState(
            runtime,
            queued,
            config,
            issues,
          );
          if (!reset.ok) {
            complete = false;
            continue;
          }
        }
        const control = controls[index];
        const id = actionId(live.state.state_id, control, index);
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
        const risk = classifyRisk(control.name, control.tag, control.type);
        if (
          (risk === RISK.DESTRUCTIVE && !config.allowDestructive) ||
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
        // After a state change the post-action restore reloaded this node —
        // the live snapshot describes exactly that origin again, so reuse it
        // instead of paying a second full snapshot per sibling.
        let before = liveIsCurrent ? live : await snapshot(runtime, config);
        let liveControl = before.controls.find(
          (item) => controlKey(item) === controlKey(control),
        );
        if (!liveControl) {
          evidence.push({
            action_id: id,
            status: "skipped",
            skip_reason: "CONTROL_NOT_PRESENT",
            control,
          });
          continue;
        }
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
        const beforeCaptured = await screenshotOrIssue(
          runtime,
          beforeShot,
          issues,
          "before-action",
        );
        let status = "observed";
        let error = null;
        let attempts = 0;
        let timedOut = false;
        const maxAttempts =
          1 + Math.max(0, config.bounds.max_retries_per_action ?? 0);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          attempts = attempt;
          try {
            await driveControl(runtime, liveControl, {
              onSoftError(pressError, kind) {
                issues.push(
                  explorerIssue(
                    "explorer",
                    "Keyboard interaction failed",
                    "low",
                    kind === "select"
                      ? "The native selectOption probe could not run on this combobox."
                      : "The combobox keyboard probe could not run on this control.",
                    {
                      action_id: id,
                      error: redact({ message: String(pressError) }),
                    },
                  ),
                );
              },
            });
            // click()/fill() already waited for stability once; a second
            // full stable poll doubled action cost without new signal.
            status = "observed";
            error = null;
            break;
          } catch (err) {
            status = "error";
            error = redact({ name: err.name, message: err.message });
            // Timeouts on missing/hidden controls do not heal on retry.
            const noRetry =
              err?.name === "TimeoutError" ||
              /Timeout \d+ms exceeded/i.test(String(err?.message || ""));
            if (noRetry) {
              timedOut = true;
              break;
            }
            if (attempt < maxAttempts) {
              const replayed = await reenterQueuedState(
                runtime,
                queued,
                config,
                issues,
              );
              if (!replayed.ok) break;
              before = replayed.snapshot;
              liveControl = before.controls.find(
                (item) => controlKey(item) === controlKey(control),
              );
              if (!liveControl) break;
            }
          }
        }
        let restoredAfterError = false;
        if (status === "error")
          restoredAfterError = await restoreOrIssue(
            runtime,
            { url: before.url, theme: before.theme },
            issues,
          );
        // Timeout on a gone control does not heal; after the successful
        // restore the page is provably back on the before-state — skip the
        // redundant after-snapshot + screenshot.
        const afterIsBefore = status === "error" && timedOut && restoredAfterError;
        const after = afterIsBefore ? before : await snapshot(runtime, config);
        let afterCaptured = false;
        if (!afterIsBefore)
          afterCaptured = await screenshotOrIssue(
            runtime,
            afterShot,
            issues,
            "after-action",
          );
        const eventDelta = endEvents();
        const urlChanged =
          normalizeUrl(before.url, config.baseUrl) !==
          normalizeUrl(after.url, config.baseUrl);
        const stateChanged = changed(before, after);
        const textChanged = before.text !== after.text;
        const controlChanged = controlSignalChanged(
          before.controls,
          after.controls,
          control,
        );
        const themeChanged = before.theme !== after.theme;
        // Pixel oracle only decides the dead-control case: when semantics
        // already prove a change, the PNG decode x2 is wasted work in the
        // common success path.
        const semanticsChanged =
          urlChanged || stateChanged || textChanged || controlChanged || themeChanged;
        let pixels = null;
        if (!semanticsChanged && beforeCaptured && afterCaptured) {
          try {
            pixels = await compareScreenshots(beforeShot, afterShot);
          } catch {
            pixels = null;
            issues.push(
              explorerIssue(
                "explorer",
                "Pixel comparison failed",
                "medium",
                "Both screenshots exist but could not be compared.",
                { action_id: id },
              ),
            );
          }
        }
        const observation = {
          url: after.url,
          url_changed: urlChanged,
          state_changed: stateChanged,
          text_changed: textChanged,
          control_changed: controlChanged,
          focus: after.focus,
          pixels_changed: pixels?.changed ?? null,
          pixel_ratio: pixels?.ratio ?? null,
          duration_ms: now() - stepStarted,
          attempts,
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
          await captureStateScreenshot(
            runtime,
            outDir,
            after.state.state_id,
            viewport,
            issues,
            evidence,
          );
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
            url: after.url,
            depth: current.depth + 1,
          });
          const replayable =
            expected !== "input-or-validation" && risk === RISK.SAFE;
          // Queue only states that can be reconstructed safely. Deterministic
          // input probes still produce evidence/findings, but do not fork the
          // BFS into state paths that require replaying form mutations.
          if (replayable) {
            queue.push({
              snapshot: after,
              depth: current.depth + 1,
              entry: queued.entry,
              path: [...queued.path, { control: liveControl }],
            });
          }
        }
        if (after.state.state_id !== before.state.state_id) {
          // Reset every branch to the live node origin before the next sibling.
          await restoreOrIssue(
            runtime,
            { url: live.url, theme: live.theme },
            issues,
          );
          // The restore reloaded the node origin: the live snapshot is the
          // current page again and the next sibling can reuse it.
          liveIsCurrent = true;
        } else {
          liveIsCurrent = false;
        }
      }
      // Only global budgets end the walk. max_depth and max_actions_per_state
      // truncate a single node, so aborting the BFS on them would silently
      // strand queued states that are still within budget.
      if (GLOBAL_LIMITS.has(limitReason)) break;
    }

    // A run that reached states and executed every available control is
    // complete even with zero actions (a page without interactive elements).
    // Only an unreachably empty graph is missing evidence: a page that never
    // rendered cannot claim coverage.
    if (!evidence.length && states.size === 0) {
      complete = false;
      limitReason ||= "no_action_evidence";
    }
    budget.actions += actions;
    budget.states += states.size;
    walkResult = {
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
    // Teardown failures are evidence too: a lost trace cannot back a finding.
    try {
      await runtime.stop(
        join(outDir, "traces", `run-${safe(viewport.name)}.zip`),
      );
    } catch (error) {
      const target = walkResult ?? {
        viewport: viewport.name,
        complete: false,
        limitReason: "teardown_failed",
        states: [],
        edges: [],
        issues: [],
        evidence: [],
        actions: 0,
      };
      target.issues.push(
        explorerIssue(
          "explorer",
          "Browser teardown failed",
          "medium",
          "Browser teardown did not complete cleanly; traces may be incomplete.",
          {
            viewport: viewport.name,
            error: redact({ message: String(error) }),
          },
        ),
      );
      target.complete = false;
      walkResult = target;
    }
  }
  return walkResult;
}

/**
 * Run one bounded walk per configured viewport and merge them into one report.
 * A viewport that is never walked is missing coverage, not a passing run.
 */
export async function explore(input = {}) {
  const config = resolveConfig(input);
  if (!config.baseUrl && config.mode !== "off")
    throw new Error("Visual QA requires baseUrl");
  const started = now();
  const outDir = config.outDir;
  await mkdir(join(outDir, "screenshots"), { recursive: true });
  await mkdir(join(outDir, "traces"), { recursive: true });

  const writeReport = (result) => writeReportArtifacts(outDir, result);

  // mode "off" never launches a browser. It reports an explicitly incomplete
  // run instead of pretending the configured coverage was examined.
  if (config.mode === "off") {
    return writeReport({
      schema_version: "vqa-0.1",
      product: "Visual QA",
      mode: "off",
      verdict: "COVERAGE_INCOMPLETE",
      complete: false,
      coverage: {
        bounds: config.bounds,
        states: 0,
        actions: 0,
        queued: 0,
        limit_reason: "mode_off",
        viewports_covered: [],
        viewports_missing: config.viewports.map((viewport) => viewport.name),
      },
      states: [],
      edges: [],
      issues: [],
      evidence: [],
      started_at: new Date(started).toISOString(),
      duration_ms: now() - started,
      config: redact({
        ...config,
        intent: config.intent ? "[configured]" : null,
      }),
    });
  }

  const entryUrls =
    config.mode === "changed"
      ? config.changedTargets.map(
          (target) => new URL(target, config.baseUrl).href,
        )
      : [config.baseUrl];

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
    // One viewport failing to boot must not erase the other viewports'
    // coverage: the aborted viewport is recorded as explicitly incomplete.
    try {
      walks.push(
        await exploreViewport(viewportConfig, viewport, budget, entryUrls),
      );
    } catch (error) {
      walks.push({
        viewport: viewport.name,
        complete: false,
        limitReason: "viewport_error",
        states: [],
        edges: [],
        issues: [
          explorerIssue(
            "explorer",
            "Viewport walk failed",
            "high",
            `The '${viewport.name}' walk aborted before completing: ${error instanceof Error ? error.message : String(error)}`,
            {
              viewport: viewport.name,
              error: redact({
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ),
        ],
        evidence: [],
        actions: 0,
      });
    }
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
  return writeReport(result);
}

function safe(input) {
  return String(input)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(-100);
}
