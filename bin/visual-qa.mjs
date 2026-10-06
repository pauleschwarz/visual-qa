#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { agentRun, loadVisualQaConfig } from "../src/agent-run.mjs";
import {
  captureBaselines,
  compareFolders,
  compareToBaseline,
} from "../src/baseline.mjs";
import { demo } from "../src/demo.mjs";
import { parseViewport, resolveBaselineConfig } from "../src/config.mjs";
import { resolveDesignContract } from "../src/design-contract.mjs";
import { explore } from "../src/explore.mjs";
import {
  geometry,
  geometryExitCode,
  parseSelectorFlags,
  parseSweep,
  resolveChecks,
} from "../src/geometry.mjs";
import { dryRunIntent, parseIntent } from "../src/intent.mjs";
import { renderJunitXml } from "../src/junit.mjs";
import { renderSummaryLines, summarizeReport } from "../src/report.mjs";
import { applyHarnessReview, prepareHarnessReview } from "../src/review.mjs";
import { writeAgentGate } from "../src/agent-gate.mjs";
import { run } from "../src/run.mjs";
import { resolveSessionInput } from "../src/session.mjs";

function usage({ error = false, message = null } = {}) {
  const text =
    "Usage:\n" +
    "  visual-qa demo [--out DIR] [bounds flags]              zero-setup first run\n" +
    "  visual-qa run --url URL [--out DIR] [--isolated] [--autofix verified] [--fix-dir DIR]\n" +
    '                 [--intent "instruction"] [--max-agent-calls N] [--mode off|changed|full] [bounds flags]\n' +
    "                 [--path-prefix PATH] [--no-prepare-review] [--no-edge-input-probes] [--design-contract FILE]\n" +
    "                 [--max-pairs N] [--max-state-pairs N] [--batch-size N] [--skills loop|all|list]\n" +
    "                 [--state NAME ...] [--journey NAME ...] [--config FILE]   named states / journeys (see README)\n" +
    "  visual-qa journeys --url URL [--only a,b | --journey NAME ...] [--out DIR] [--config FILE]   scripted journeys from the config\n" +
    "  visual-qa explore --url URL [--out DIR] [bounds flags]  deterministic core only\n" +
    "  visual-qa report <DIR> [--json]                         summarize an out-dir for agents\n" +
    '  visual-qa intent --intent "..." --fix-dir DIR [--json]   catalog dry-run, no browser\n' +
    "  visual-qa review-prepare <DIR> [--max-pairs N] [--max-state-pairs N] [--batch-size N] [--skills loop|all|list]\n" +
    "                                                         export subagent vision batches (default path)\n" +
    "  visual-qa review-apply <DIR> <findings.json>            apply harness findings (fail-closed coverage)\n" +
    "  visual-qa baseline capture --url URL [--out DIR] [--route PATH ...] [--viewport name=WxH ...]\n" +
    "                 [--clock ISO] [--locale TAG] [--timezone ZONE]   calm screenshots: top, page, every inner scroller\n" +
    "  visual-qa baseline compare --url URL --baseline DIR [--out DIR] [--threshold-pct N] [--pixel-threshold N]\n" +
    "                 [route/viewport flags]\n" +
    "                                                         capture now under the baseline's conditions, diff, report.md; exit 1 on change\n" +
    "  visual-qa baseline diff DIR_A DIR_B [--out DIR] [--threshold-pct N] [--pixel-threshold N]\n" +
    "                                                         compare two folders, no browser; --out must be empty or an earlier compare\n" +
    "  visual-qa baseline-capture --url URL --out DIR [--changed-target URL ...]   alias of baseline capture\n" +
    "  visual-qa geometry --url URL [--route PATH ...] [--viewport name=WxH ...] [--sweep FROM-TO[:STEP]] [--height N]\n" +
    "                 [--checks a,b] [--selector first-view=CSS|stable=[hover:]CSS ...] [--state NAME ...] [--config FILE]\n" +
    "                 [--min-gap N] [--touch-max N] [--out DIR]   first view, covered, stable, edges, text fit, rows, tap size; exit 1 on a finding\n" +
    "  visual-qa agent-run [--url URL] [--baseline-url URL] [--out DIR] [--base REF]\n" +
    "                 [--design-contract FILE]                git change set → routes → observe/compare only\n" +
    "  visual-qa agent-gate <QA-DIR> <verity.json> [--json]     join independent Visual QA + Verity evidence\n" +
    "Output flags (run/explore): --format human|json|junit, --out-file FILE (junit)\n" +
    "Mode flags:   --changed-target URL (repeatable, required for --mode changed)\n" +
    "              --path-prefix PATH (skip same-origin links outside pathname prefix)\n" +
    "              --baseline-dir DIR (<route-key>/<viewport>.png or legacy <viewport>.png)\n" +
    "              --threshold-pct N (share of pixels that may differ from the baseline, default 0.0005)\n" +
    "              --pixel-threshold N (colour distance 0–1 for a pixel to differ, default 0.05)\n" +
    "              --internal-scrollers-as-finding (inner scroll areas are info by default; opt in to report them)\n" +
    "              --design-contract FILE (DESIGN.md; auto-discover DESIGN.md in cwd when present)\n" +
    "              --allow-destructive (only with --isolated)\n" +
    "Geometry:     --geometry (run/explore) adds the geometry checks to every state; off by default\n" +
    "Review flags (run): --no-prepare-review  skip auto vision task export\n" +
    "              --no-edge-input-probes     skip empty/hostile/overlong fills\n" +
    "Bounds flags: --max-states N --max-depth N --max-actions N --max-actions-per-state N --max-runtime-ms N\n" +
    "Help:         visual-qa --help    Version: visual-qa --version\n" +
    "Note: visual-qa observes and evidences only; it does not redesign or auto-code UI.";
  const output = message ? `${message}\n\n${text}` : text;
  (error ? console.error : console.log)(output);
  process.exitCode = error ? 2 : 0;
}

const VALUE_OPTIONS = new Set([
  "--out",
  "--url",
  "--mode",
  "--baseline-dir",
  "--baseline-url",
  "--baseline",
  "--route",
  "--viewport",
  "--clock",
  "--locale",
  "--timezone",
  "--threshold-pct",
  "--pixel-threshold",
  "--changed-target",
  "--path-prefix",
  "--design-contract",
  "--git-ref",
  "--base",
  "--autofix",
  "--fix-dir",
  "--intent",
  "--format",
  "--out-file",
  "--max-states",
  "--max-depth",
  "--max-actions",
  "--max-actions-per-state",
  "--max-runtime-ms",
  "--max-agent-calls",
  "--max-pairs",
  "--max-state-pairs",
  "--skills",
  "--batch-size",
  "--state",
  "--journey",
  "--only",
  "--config",
  "--sweep",
  "--height",
  "--checks",
  "--selector",
  "--min-gap",
  "--touch-max",
]);

function validateOptionValues(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!VALUE_OPTIONS.has(token)) continue;
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`visual-qa: ${token} requires a value`);
    index += 1;
  }
}

/** One line per route (or "whole app") and changed file: why it is part of the run. */
function routeReasonLines(agent) {
  const lines = [];
  const because = ({ file, pattern, via = [] }) =>
    `${[file, ...via].join(" → ")} (${pattern})`;
  for (const [route, reasons] of Object.entries(agent?.route_reasons ?? {}))
    for (const reason of reasons) lines.push(`  ${route} ← ${because(reason)}`);
  for (const reason of agent?.full_reasons ?? []) lines.push(`  whole app ← ${because(reason)}`);
  return lines;
}

/** What a "no UI diff" noop left out: every changed file is a non-UI one (a data file, an asset, an ignored one). */
function notUiNote({ changed_files: changed }) {
  if (!changed.length) return "";
  const shown = changed.slice(0, 5).join(", ");
  return ` — changed, not UI files (see trigger/ignore in .visual-qa.yml): ${shown}${changed.length > 5 ? `, … (${changed.length} in all)` : ""}`;
}

function reportWasBlocked(report) {
  return (
    report.coverage?.states === 0 &&
    report.coverage?.limit_reason === "viewport_error"
  );
}

function exitCodeForReport(report) {
  if (reportWasBlocked(report)) return 2;
  return report.verdict === "PASS" ? 0 : 1;
}

const BASELINE_FLAGS = {
  capture: ["--url", "--out", "--route", "--changed-target", "--viewport", "--clock", "--locale", "--timezone"],
  compare: ["--url", "--baseline", "--out", "--route", "--changed-target", "--viewport", "--clock", "--locale", "--timezone", "--threshold-pct", "--pixel-threshold"],
  diff: ["--out", "--threshold-pct", "--pixel-threshold"],
};

/** `baseline capture|compare|diff` (and the alias `baseline-capture`). Returns the exit code. */
async function baselineCommand(sub, rest) {
  const allowed = BASELINE_FLAGS[sub];
  if (!allowed) {
    usage({ error: true, message: `visual-qa baseline: expected capture, compare or diff, got "${sub ?? ""}"` });
    return 2;
  }
  const opts = {};
  const routes = [];
  const viewports = [];
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (!allowed.includes(arg)) {
      usage({ error: true, message: `baseline ${sub}: flag ${arg} does not apply` });
      return 2;
    } else if (arg === "--route" || arg === "--changed-target") routes.push(rest[++i]);
    else if (arg === "--viewport") viewports.push(rest[++i]);
    else opts[arg.slice(2)] = rest[++i];
  }
  const need = (ok, message) => {
    if (ok) return false;
    usage({ error: true, message: `baseline ${sub}: ${message}` });
    return true;
  };
  if (sub === "diff" ? need(positional.length === 2, "needs exactly two folders: diff DIR_A DIR_B") : need(positional.length === 0, `unexpected argument ${positional[0]}`)) return 2;
  if (sub !== "diff" && need(opts.url, "requires --url")) return 2;
  if (sub === "compare" && need(opts.baseline, "requires --baseline DIR")) return 2;
  try {
    const { config } = await loadVisualQaConfig(process.cwd());
    const given = { ...config.baseline };
    if (routes.length) given.routes = routes;
    if (viewports.length) given.viewports = viewports;
    for (const key of ["clock", "locale", "timezone", "threshold-pct", "pixel-threshold"])
      if (opts[key] !== undefined) given[key.replace("-", "_")] = opts[key];
    const cfg = resolveBaselineConfig(given);
    // Values the user did not set stay null so compare can inherit the baseline's own.
    const common = { clock: cfg.clock ?? undefined, locale: cfg.locale ?? undefined, timezone: cfg.timezone ?? undefined };
    if (sub === "diff") {
      const [a, b] = positional.map((p) => resolve(p));
      const result = await compareFolders(a, b, {
        thresholdPct: cfg.threshold_pct,
        pixelThreshold: cfg.pixel_threshold,
        outDir: resolve(opts.out ?? b),
      });
      console.log(result.report);
      return result.ok ? 0 : 1;
    }
    if (sub === "capture") {
      const result = await captureBaselines({
        baseUrl: opts.url,
        outDir: resolve(opts.out ?? ".qa-baselines"),
        targets: cfg.routes.length ? cfg.routes : ["/"],
        ...(cfg.viewports ? { viewports: cfg.viewports } : {}),
        ...common,
      });
      console.log(`baseline capture: ${result.entries.length} images, ${result.errors.length} load errors → ${result.outDir}`);
      for (const e of result.errors) console.log(`  ${e.route} · ${e.viewport}: ${e.message}`);
      for (const e of result.skipped) console.log(`  not captured: ${e.route} · ${e.viewport} · ${e.part} — ${e.reason}`);
      console.log(`manifest: ${result.manifestPath}`);
      return result.errors.length ? 1 : 0;
    }
    const result = await compareToBaseline({
      baseUrl: opts.url,
      baselineDir: resolve(opts.baseline),
      outDir: resolve(opts.out ?? ".qa-baseline-compare"),
      targets: cfg.routes,
      viewports: cfg.viewports,
      thresholdPct: cfg.threshold_pct,
      pixelThreshold: cfg.pixel_threshold,
      ...common,
    });
    console.log(result.report);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    return 2;
  }
}

const GEOMETRY_FLAGS = [
  "--url", "--out", "--route", "--viewport", "--sweep", "--height", "--checks", "--selector",
  "--state", "--config", "--min-gap", "--touch-max",
];

/** `geometry`: measure first view, covered, stable, edges, text fit, rows and tap size across viewports. Returns the exit code. */
async function geometryCommand(rest) {
  const opts = {};
  const lists = { "--route": [], "--viewport": [], "--selector": [], "--state": [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!GEOMETRY_FLAGS.includes(arg)) {
      usage({ error: true, message: `geometry: ${arg.startsWith("--") ? `flag ${arg} does not apply` : `unexpected argument ${arg}`}` });
      return 2;
    }
    if (arg in lists) lists[arg].push(rest[++i]);
    else opts[arg.slice(2)] = rest[++i];
  }
  const number = (name, min) => {
    if (opts[name] === undefined) return undefined;
    const value = Number(opts[name]);
    if (!Number.isFinite(value) || value < min) throw new Error(`--${name} must be a number >= ${min}`);
    return value;
  };
  try {
    if (!opts.url) throw new Error("geometry requires --url");
    const selectors = parseSelectorFlags(lists["--selector"]);
    const checks = resolveChecks(opts.checks, selectors);
    const viewports = lists["--viewport"].map(parseViewport);
    const sweep = opts.sweep === undefined ? null : parseSweep(opts.sweep);
    // Left out when not given, so the defaults of src/geometry.mjs stay the one place they live.
    const given = (key, value) => (value === undefined ? {} : { [key]: value });
    const input = {
      baseUrl: opts.url,
      outDir: resolve(opts.out ?? ".qa-geometry"),
      routes: lists["--route"],
      viewports,
      sweep,
      checks,
      selectors,
      ...given("height", number("height", 200)),
      ...given("minGap", number("min-gap", 0)),
      ...given("touchMax", number("touch-max", 1)),
    };
    if (lists["--state"].length) {
      const { path, config: project } = await loadVisualQaConfig(process.cwd(), opts.config);
      if (!path) throw new Error("states come from .visual-qa.yml (or --config FILE); none found");
      for (const warning of project.warnings) console.error(`visual-qa: warning: ${warning}`);
      const { session, stateDefs } = await resolveSessionInput(project, { baseDir: dirname(path), states: lists["--state"] });
      Object.assign(input, { session, stateDefs, states: lists["--state"] });
    }
    const result = await geometry(input);
    console.log(result.report);
    console.log(`report: ${join(result.outDir, "report.md")} · machine report: ${join(result.outDir, "report.json")}`);
    return geometryExitCode(result);
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    return 2;
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
  usage();
  process.exit(0);
}
if (args[0] === "--version" || args[0] === "-v") {
  const { createRequire } = await import("node:module");
  console.log(createRequire(import.meta.url)("../package.json").version);
  process.exit(0);
}
const command = args.shift();
try {
  validateOptionValues(args);
} catch (error) {
  usage({ error: true, message: error.message });
  process.exit(2);
}

/**
 * Print or persist the run result in the requested format. json goes to
 * stdout (harness consumption), junit to a file when --out-file is given,
 * otherwise to stdout (CI systems ingest it directly).
 */
async function emitResult(report, { format, outDir, outFile }) {
  if (format === "json") {
    console.log(JSON.stringify(summarizeReport(report), null, 2));
    return;
  }
  if (format === "junit") {
    const xml = renderJunitXml(report);
    if (outFile) {
      const path = resolve(outFile);
      try {
        await writeFile(path, xml);
        console.log(`junit report: ${path}`);
      } catch (error) {
        throw new Error(
          `Could not write JUnit report at ${path}: ${error.message}`,
        );
      }
    } else {
      console.log(xml);
    }
    return;
  }
  console.log(
    `Visual QA ${reportWasBlocked(report) ? "BLOCKED" : report.verdict} | states=${report.coverage.states} actions=${report.coverage.actions} issues=${report.issues.length}`,
  );
  for (const [phase, info] of Object.entries(report.phases || {}))
    console.log(`  ${phase}: ${JSON.stringify(info)}`);
  if (report.coverage.limit_reason)
    console.log(`coverage incomplete: ${report.coverage.limit_reason}`);
  for (const issue of summarizeReport(report).issues)
    console.log(`${issue.severity.toUpperCase()} ${issue.id}: ${issue.title}`);
  console.log(`open report: ${join(resolve(outDir), "report.html")}`);
  console.log(`machine report: ${join(resolve(outDir), "report.json")}`);
}

if (command === "agent-gate") {
  const qaDir = args[0] && !args[0].startsWith("--") ? args.shift() : null;
  const verityFile = args[0] && !args[0].startsWith("--") ? args.shift() : null;
  const json = args.length === 1 && args[0] === "--json";
  if (!qaDir || !verityFile || args.length > (json ? 1 : 0)) {
    usage({
      error: true,
      message: "visual-qa agent-gate requires <QA-DIR> <verity.json> [--json]",
    });
    process.exit(2);
  }
  try {
    const result = await writeAgentGate(resolve(qaDir), {
      visualFile: join(resolve(qaDir), "report.json"),
      verityFile: resolve(verityFile),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Agent gate ${result.verdict} | blockers=${result.blockers.length}`);
      for (const blocker of result.blockers) console.log(`BLOCKER ${blocker}`);
      console.log(`receipt: ${result.path}`);
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`Agent gate BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else if (command === "baseline" || command === "baseline-capture") {
  process.exitCode = await baselineCommand(
    command === "baseline-capture" ? "capture" : args.shift(),
    args,
  );
} else if (command === "geometry") {
  process.exitCode = await geometryCommand(args);
} else if (command === "agent-run") {
  let url = null;
  let baselineUrl = null;
  let outDir = ".qa-agent";
  let base = null;
  let designContractPath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url") url = args[++i];
    else if (arg === "--baseline-url") baselineUrl = args[++i];
    else if (arg === "--out") outDir = args[++i];
    else if (arg === "--base" || arg === "--git-ref") base = args[++i];
    else if (arg === "--design-contract") designContractPath = args[++i];
    else {
      usage({ error: true, message: `Unknown agent-run flag: ${arg}` });
      process.exit(2);
    }
  }
  try {
    const result = await agentRun({
      url,
      baselineUrl,
      outDir: resolve(outDir),
      projectRoot: process.cwd(),
      base,
      designContractPath,
    });
    for (const warning of result.agent?.config_warnings ?? [])
      console.error(`visual-qa: warning: ${warning}`);
    for (const file of result.agent?.unmapped_files ?? [])
      console.error(`visual-qa: warning: no route_map entry reaches ${file}`);
    for (const file of result.agent?.unrendered_files ?? [])
      console.error(
        `visual-qa: warning: nothing imports ${file}, so no route shows its change. An entry point (main.tsx, index.html) or a file loaded in a way the import scan cannot follow (import.meta.glob, a computed import)? Map it in route_map directly (GLOBAL for an entry point)`,
      );
    for (const file of result.agent?.depth_exhausted_files ?? [])
      console.error(
        `visual-qa: warning: ${file} is imported further up than import_depth ${result.agent.import_depth}; those importers were not followed (raise import_depth in .visual-qa.yml)`,
      );
    for (const line of routeReasonLines(result.agent)) console.log(line);
    if (result.noop) {
      console.log(
        result.agent.reason === "unrendered"
          ? `agent-run: changed files are imported by nothing (${result.agent.unrendered_files.join(", ")}) → PASS (noop)`
          : `agent-run: no UI diff → PASS (noop)${notUiNote(result.agent.git)}`,
      );
      process.exitCode = 0;
    } else {
      console.log(
        `agent-run ${result.report.verdict} | mode=${result.agent.mode} routes=${(result.agent.routes || []).join(",") || "-"} | out=${result.outDir}`,
      );
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else if (command === "report") {
  const dir = args[0] && !args[0].startsWith("--") ? args.shift() : null;
  const json = args.includes("--json");
  const unknown = args.filter((a) => a !== "--json");
  if (!dir || unknown.length) {
    usage();
    process.exit(2);
  }
  try {
    const report = JSON.parse(
      await readFile(join(resolve(dir), "report.json"), "utf8"),
    );
    const summary = summarizeReport(report);
    if (json) console.log(JSON.stringify(summary, null, 2));
    else console.log(renderSummaryLines(summary).join("\n"));
    process.exitCode = exitCodeForReport(report);
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else if (command === "intent") {
  const intents = [];
  let fixDir = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--intent") intents.push(args[++i]);
    else if (arg === "--fix-dir") fixDir = resolve(args[++i]);
    else if (arg === "--json") json = true;
    else {
      usage();
      process.exit(2);
    }
  }
  if (!intents.length || !fixDir) {
    usage({
      error: true,
      message: "visual-qa intent requires --intent and --fix-dir",
    });
    process.exit(2);
  }
  const results = [];
  let allGood = true;
  for (const raw of intents) {
    const parsed = parseIntent(raw);
    if (!parsed) {
      results.push({ intent: raw, parsed: false });
      allGood = false;
      continue;
    }
    const dry = await dryRunIntent(parsed, fixDir);
    results.push({ intent: raw, ...dry });
    if (!dry.found) allGood = false;
  }
  if (json) console.log(JSON.stringify({ ok: allGood, results }, null, 2));
  else
    for (const result of results) {
      const status = !result.parsed
        ? "UNPARSED"
        : result.found
          ? `FOUND ${result.file}`
          : `MISSING (${result.reason})`;
      console.log(`${status}: ${result.intent}`);
    }
  process.exitCode = allGood ? 0 : 1;
} else if (command === "review-prepare" || command === "review-apply") {
  const positional = [];
  let maxPairs = 3;
  let maxStatePairs = 3;
  let batchSize = 6;
  let skills = "loop";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--max-pairs") maxPairs = Number(args[++i]);
    else if (arg === "--max-state-pairs") maxStatePairs = Number(args[++i]);
    else if (arg === "--batch-size") batchSize = Number(args[++i]);
    else if (arg === "--skills") skills = args[++i];
    else if (!arg.startsWith("--")) positional.push(arg);
    else {
      usage();
      process.exit(2);
    }
  }
  try {
    if (!Number.isInteger(maxPairs) || maxPairs < 1)
      throw new Error("--max-pairs must be an integer >= 1");
    if (!Number.isInteger(maxStatePairs) || maxStatePairs < 0)
      throw new Error("--max-state-pairs must be an integer >= 0");
    if (!Number.isInteger(batchSize) || batchSize < 1)
      throw new Error("--batch-size must be an integer >= 1");
    if (command === "review-prepare") {
      const [dir] = positional;
      if (!dir) {
        usage();
        process.exit(2);
      }
      const report = JSON.parse(
        await readFile(join(resolve(dir), "report.json"), "utf8"),
      );
      const prepared = await prepareHarnessReview(report, resolve(dir), {
        maxPairs,
        maxStatePairs,
        batchSize,
        skills,
      });
      console.log(
        `vision review tasks: ${prepared.requests} requests in ${prepared.batches} batches -> ${prepared.file}`,
      );
      console.log(`subagent plan: ${prepared.planFile}`);
      console.log(
        "DEFAULT: spawn one short-lived reviewer (e.g. smart) per vision/batches/batch-XX.json; merge results into vision/findings.json; visual-qa review-apply. No API key.",
      );
      process.exitCode = 0;
    } else {
      const [dir, findingsFile] = positional;
      if (!dir || !findingsFile) {
        usage();
        process.exit(2);
      }
      const result = await applyHarnessReview(
        resolve(dir),
        resolve(findingsFile),
      );
      console.log(
        `harness review applied: +${result.accepted} findings (rejected ${result.rejected}) | verdict ${result.verdict} | vision_complete=${result.vision_complete} | issues=${result.issues}`,
      );
      if (!result.vision_complete) {
        console.log(
          `COVERAGE_INCOMPLETE vision: missing=${(result.missing || []).length} invalid=${(result.invalid || []).length}`,
        );
        if (result.missing?.length)
          console.log(`missing ids: ${result.missing.join(", ")}`);
        if (result.invalid?.length)
          console.log(
            `invalid: ${result.invalid.map((e) => `${e.id || "(empty)"}:${e.reason}`).join("; ")}`,
          );
      }
      console.log(`open report: ${join(resolve(dir), "report.html")}`);
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else if (command === "demo") {
  let outDir = ".qa-demo";
  const bounds = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") outDir = args[++i];
    else if (arg === "--max-states") bounds.max_states = Number(args[++i]);
    else if (arg === "--max-depth") bounds.max_depth = Number(args[++i]);
    else if (arg === "--max-actions")
      bounds.max_total_actions = Number(args[++i]);
    else if (arg === "--max-actions-per-state")
      bounds.max_actions_per_state = Number(args[++i]);
    else if (arg === "--max-runtime-ms")
      bounds.max_runtime_ms = Number(args[++i]);
    else {
      usage();
      process.exit(2);
    }
  }
  try {
    console.log("Visual QA demo | walking an intentionally broken fixture…");
    const report = await demo({ outDir: resolve(outDir), bounds });
    await emitResult(report, { format: "human", outDir });
    console.log(
      "Demo complete: findings are expected here. Next, run visual-qa against your own URL.",
    );
    // The demo seeds defects on purpose: findings are the success case, so
    // the exit code reports blockage only when the run could not happen.
    process.exitCode = reportWasBlocked(report) ? 2 : 0;
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else if (command === "explore" || command === "run" || command === "journeys") {
  let baseUrl,
    outDir = ".qa",
    mode = "full",
    isolatedEnvironment = false,
    allowDestructive = false,
    autofix = null,
    fixDir = null,
    intent = null,
    baselineDir = null,
    thresholdPct = undefined,
    pixelThreshold = undefined,
    internalScrollers = "info",
    designContractPath = null,
    pathPrefix = null,
    format = "human",
    outFile = null,
    prepareReview = true,
    edgeInputProbes = true,
    geometryChecks = false,
    reviewMaxPairs = null,
    reviewMaxStatePairs = null,
    reviewBatchSize = null,
    reviewSkills = null,
    configFile = null,
    only = null;
  const bounds = {};
  const changedTargets = [];
  const stateNames = [];
  const journeyNames = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url") baseUrl = args[++i];
    else if (arg === "--out") outDir = args[++i];
    else if (arg === "--mode") mode = args[++i];
    else if (arg === "--isolated") isolatedEnvironment = true;
    else if (arg === "--allow-destructive") allowDestructive = true;
    else if (arg === "--baseline-dir") baselineDir = resolve(args[++i]);
    else if (arg === "--threshold-pct") thresholdPct = Number(args[++i]);
    else if (arg === "--pixel-threshold") pixelThreshold = Number(args[++i]);
    else if (arg === "--internal-scrollers-as-finding") internalScrollers = "finding";
    else if (arg === "--design-contract") designContractPath = args[++i];
    else if (arg === "--changed-target") changedTargets.push(args[++i]);
    else if (arg === "--path-prefix") pathPrefix = args[++i];
    else if (arg === "--autofix") autofix = args[++i];
    else if (arg === "--fix-dir") fixDir = resolve(args[++i]);
    else if (arg === "--intent") intent = args[++i];
    else if (arg === "--format") format = args[++i];
    else if (arg === "--out-file") outFile = args[++i];
    else if (arg === "--no-prepare-review") prepareReview = false;
    else if (arg === "--no-edge-input-probes") edgeInputProbes = false;
    else if (arg === "--geometry") geometryChecks = true;
    else if (arg === "--max-states") bounds.max_states = Number(args[++i]);
    else if (arg === "--max-depth") bounds.max_depth = Number(args[++i]);
    else if (arg === "--max-actions")
      bounds.max_total_actions = Number(args[++i]);
    else if (arg === "--max-actions-per-state")
      bounds.max_actions_per_state = Number(args[++i]);
    else if (arg === "--max-runtime-ms")
      bounds.max_runtime_ms = Number(args[++i]);
    else if (arg === "--max-agent-calls")
      bounds.max_agent_calls = Number(args[++i]);
    else if (arg === "--max-pairs") reviewMaxPairs = Number(args[++i]);
    else if (arg === "--max-state-pairs") reviewMaxStatePairs = Number(args[++i]);
    else if (arg === "--batch-size") reviewBatchSize = Number(args[++i]);
    else if (arg === "--skills") reviewSkills = args[++i];
    else if (arg === "--state") stateNames.push(args[++i]);
    else if (arg === "--journey") journeyNames.push(args[++i]);
    else if (arg === "--config") configFile = args[++i];
    else if (arg === "--only") only = args[++i];
    else {
      usage();
      process.exit(2);
    }
  }
  if (only !== null && command !== "journeys") {
    console.error("visual-qa: --only belongs to the journeys command");
    process.exit(2);
  }
  if (!baseUrl && mode !== "off") {
    usage();
    process.exit(2);
  }
  if (mode === "changed" && changedTargets.length === 0) {
    console.error(
      "visual-qa: --mode changed requires at least one --changed-target",
    );
    process.exit(2);
  }
  if (!["human", "json", "junit"].includes(format)) {
    console.error(`visual-qa: unknown --format "${format}"`);
    process.exit(2);
  }
  if (autofix && autofix !== "verified") {
    console.error('visual-qa: --autofix only accepts "verified"');
    process.exit(2);
  }
  if (command === "explore" && (autofix || fixDir || intent)) {
    console.error(
      "visual-qa: autofix, fix-dir, and intent require the run command",
    );
    process.exit(2);
  }
  if (outFile && format !== "junit") {
    console.error("visual-qa: --out-file requires --format junit");
    process.exit(2);
  }
  if (reviewMaxPairs !== null && (!Number.isInteger(reviewMaxPairs) || reviewMaxPairs < 1)) {
    console.error("visual-qa: --max-pairs must be an integer >= 1");
    process.exit(2);
  }
  if (
    reviewMaxStatePairs !== null &&
    (!Number.isInteger(reviewMaxStatePairs) || reviewMaxStatePairs < 0)
  ) {
    console.error("visual-qa: --max-state-pairs must be an integer >= 0");
    process.exit(2);
  }
  if (
    reviewBatchSize !== null &&
    (!Number.isInteger(reviewBatchSize) || reviewBatchSize < 1)
  ) {
    console.error("visual-qa: --batch-size must be an integer >= 1");
    process.exit(2);
  }
  if (allowDestructive && !isolatedEnvironment) {
    console.error("visual-qa: --allow-destructive requires --isolated");
    process.exit(2);
  }
  try {
    if (designContractPath) {
      // Fail early on explicit unreadable contract before browser work.
      await resolveDesignContract({
        explicitPath: designContractPath,
        projectRoot: process.cwd(),
      });
    }
    const sessionInput = {};
    if (command === "journeys" || stateNames.length || journeyNames.length) {
      const { path, config: project } = await loadVisualQaConfig(
        process.cwd(),
        configFile,
      );
      if (!path)
        throw new Error(
          "states and journeys come from .visual-qa.yml (or --config FILE); none found",
        );
      for (const warning of project.warnings)
        console.error(`visual-qa: warning: ${warning}`);
      // On `journeys`, --only a,b and --journey a --journey b both name journeys; naming none runs all.
      const named = [
        ...(only === null ? [] : only.split(",").map((name) => name.trim())),
        ...journeyNames,
      ].filter(Boolean);
      const journeysToRun =
        command === "journeys"
          ? named.length
            ? named
            : Object.keys(project.journeys)
          : journeyNames;
      if (command === "journeys" && !journeysToRun.length)
        throw new Error("no journeys defined in the config (journeys: …)");
      Object.assign(
        sessionInput,
        await resolveSessionInput(project, {
          baseDir: dirname(path),
          states: stateNames,
          journeys: journeysToRun,
        }),
      );
    }
    const input = {
      ...sessionInput,
      baseUrl,
      outDir: resolve(outDir),
      mode,
      isolatedEnvironment,
      allowDestructive,
      baselineDir,
      baseline: { threshold_pct: thresholdPct, pixel_threshold: pixelThreshold },
      internalScrollers,
      designContractPath,
      projectRoot: process.cwd(),
      changedTargets,
      pathPrefix,
      autofix,
      fixDir,
      intent,
      bounds,
      prepareReview,
      edgeInputProbes,
      geometry: geometryChecks,
      reviewMaxPairs,
      reviewMaxStatePairs,
      reviewBatchSize,
      reviewSkills,
    };
    if (format === "human") {
      const seconds = Math.ceil((bounds.max_runtime_ms ?? 900_000) / 1000);
      console.log(
        `Visual QA inspect | ${baseUrl ?? "browser disabled"} | budget up to ${seconds}s`,
      );
    }
    const report = command === "run" ? await run(input) : await explore(input);
    await emitResult(report, { format, outDir, outFile });
    process.exitCode = exitCodeForReport(report);
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else {
  usage({
    error: true,
    message: command
      ? `visual-qa: unknown command "${command}"`
      : "visual-qa: missing command",
  });
  process.exit(2);
}
