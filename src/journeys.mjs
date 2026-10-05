// Visual QA - scripted journeys.
//
// A journey is the one path a user must be able to finish (sign in, add to
// cart, pay). The project writes it as a small .mjs file; visual-qa runs it
// per viewport, keeps an image and the visible text of every step, and stops at
// the first red step or check with a stop image.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BrowserRuntime } from "./browser.mjs";
import {
  dedupeIssues,
  issue,
  runA11y,
  runLayoutChecks,
  runRuntimeChecks,
} from "./checks.mjs";
import {
  fileSafe,
  importProjectModule,
  newWalk,
  SetupError,
  sessionHooks,
  writeShot,
} from "./session.mjs";

const firstLine = (error) => String(error?.message ?? error).split("\n")[0];

async function runOne({ config, viewport, journey, walk, budget }) {
  const dir = join(
    config.outDir,
    "journeys",
    fileSafe(journey.name),
    fileSafe(viewport.name),
  );
  await mkdir(dir, { recursive: true });
  const ctx = {
    baseUrl: config.baseUrl,
    state: null,
    viewport,
    locale: "en-US",
  };
  const runtime = new BrowserRuntime({
    baseUrl: config.baseUrl,
    viewport,
    trace: false,
    outDir: config.outDir,
    stableFrames: config.stable_frames,
    stableGap: config.stable_gap_ms,
    navigationTimeout: config.navigation_timeout_ms,
    ...sessionHooks({
      session: config.session,
      def: { fresh: journey.fresh },
      ctx,
    }),
  });
  let steps = 0;
  let failure = null;
  const record = async (kind, name, run) => {
    if (failure) return;
    steps += 1;
    const label = `${String(steps).padStart(2, "0")}-${fileSafe(name)}`;
    const end = runtime.markStep(`journey:${journey.name}:${name}`);
    let problem = null;
    try {
      const result = await run(runtime.page, ctx);
      if (kind === "check" && result !== true)
        problem =
          typeof result === "string" && result
            ? result
            : `check returned ${String(result)}; return true when it holds, or a string saying why not`;
    } catch (error) {
      problem = firstLine(error);
    }
    await runtime.waitForStableState({
      frames: config.stable_frames,
      gap: config.stable_gap_ms,
    });
    const shot = await writeShot(
      runtime,
      join(dir, problem ? `${label}-FAILED` : label),
    );
    const stateId = `journey:${journey.name}:${label}`;
    walk.states.push({
      state_id: stateId,
      name: journey.name,
      kind: "journey_step",
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
    budget.states += 1;
    walk.issues.push(
      ...(await runRuntimeChecks({ ...end(), baseUrl: config.baseUrl })),
    );
    if (problem) {
      failure = { kind, name, problem };
      walk.issues.push(
        issue(
          "journey",
          `Journey ${journey.name} failed at ${kind} ${name}`,
          "high",
          `${kind} "${name}" failed on ${viewport.name}: ${problem}`,
          {
            journey: journey.name,
            step: name,
            viewport: viewport.name,
            screenshot: shot.screenshot,
            text: shot.text,
          },
        ),
      );
      return;
    }
    walk.issues.push(
      ...(await runA11y(runtime.page)),
      ...(await runLayoutChecks(runtime.page, viewport)),
    );
  };

  try {
    await runtime.start();
    // Playwright waits 30s for a missing target by default; a journey step
    // that cannot find its element should fail as fast as a page load.
    runtime.page.setDefaultTimeout(config.navigation_timeout_ms);
    const module = await importProjectModule(journey.file, "journey");
    try {
      await module.default({
        step: (name, run) => record("step", name, run),
        check: (name, run) => record("check", name, run),
      });
    } catch (error) {
      if (!failure) {
        failure = { kind: "journey", name: journey.name, problem: firstLine(error) };
        const shot = await writeShot(runtime, join(dir, "FAILED"));
        walk.issues.push(
          issue(
            "journey",
            `Journey ${journey.name} threw outside a step`,
            "high",
            `${firstLine(error)} (on ${viewport.name}; wrap page actions in step() to get a per-step image)`,
            { journey: journey.name, viewport: viewport.name, screenshot: shot.screenshot },
          ),
        );
      }
    }
    if (!steps && !failure)
      walk.issues.push(
        issue(
          "journey",
          `Journey ${journey.name} recorded no steps`,
          "medium",
          `${journey.file} never called step() or check(); nothing was proven.`,
          { journey: journey.name },
        ),
      );
  } catch (error) {
    if (error instanceof SetupError) throw error;
    walk.complete = false;
    walk.limitReason ||= "journey_error";
    walk.issues.push(
      issue(
        "journey",
        `Journey ${journey.name} could not run`,
        "high",
        `${firstLine(error)} (on ${viewport.name})`,
        { journey: journey.name, viewport: viewport.name },
      ),
    );
  } finally {
    await runtime.stop();
  }
}

/** Run every selected journey on every viewport. Walk-shaped results, like exploration. */
export async function runJourneys(config, { started, budget }) {
  const walks = [];
  for (const viewport of config.viewports) {
    const walk = newWalk(viewport);
    for (const journey of config.journeys) {
      if (Date.now() - started > config.bounds.max_runtime_ms) {
        walk.complete = false;
        walk.limitReason ||= "max_runtime_ms";
        break;
      }
      await runOne({ config, viewport, journey, walk, budget });
    }
    walk.issues = dedupeIssues(walk.issues);
    walks.push(walk);
  }
  return walks;
}
