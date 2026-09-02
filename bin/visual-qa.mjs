#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { demo } from "../src/demo.mjs";
import { explore } from "../src/explore.mjs";
import { dryRunIntent, parseIntent } from "../src/intent.mjs";
import { renderJunitXml } from "../src/junit.mjs";
import { renderSummaryLines, summarizeReport } from "../src/report.mjs";
import {
  applyHarnessReview,
  prepareHarnessReview,
} from "../src/review.mjs";
import { run } from "../src/run.mjs";

function usage({ error = false, message = null } = {}) {
  const text =
    "Usage:\n" +
    "  visual-qa demo [--out DIR] [bounds flags]              zero-setup first run\n" +
    "  visual-qa run --url URL [--out DIR] [--isolated] [--autofix verified] [--fix-dir DIR]\n" +
    "                 [--intent \"instruction\"] [--max-agent-calls N] [--mode off|changed|full] [bounds flags]\n" +
    "  visual-qa explore --url URL [--out DIR] [bounds flags]  deterministic core only\n" +
    "  visual-qa report <DIR> [--json]                         summarize an out-dir for agents\n" +
    "  visual-qa intent --intent \"...\" --fix-dir DIR [--json]   catalog dry-run, no browser\n" +
    "  visual-qa review-prepare <DIR> [--max-pairs N]          export vision tasks for your harness\n" +
    "  visual-qa review-apply <DIR> <findings.json>            apply your model's findings (additive)\n" +
    "Output flags (run/explore): --format human|json|junit, --out-file FILE (junit)\n" +
    "Mode flags:   --changed-target URL (repeatable, required for --mode changed)\n" +
    "              --baseline-dir DIR (per-viewport <name>.png baselines)\n" +
    "              --allow-destructive (only with --isolated)\n" +
    "Bounds flags: --max-states N --max-depth N --max-actions N --max-actions-per-state N --max-runtime-ms N\n" +
    "Help:         visual-qa --help    Version: visual-qa --version";
  const output = message ? `${message}\n\n${text}` : text;
  (error ? console.error : console.log)(output);
  process.exitCode = error ? 2 : 0;
}

const VALUE_OPTIONS = new Set([
  "--out", "--url", "--mode", "--baseline-dir", "--changed-target",
  "--autofix", "--fix-dir", "--intent", "--format", "--out-file",
  "--max-states", "--max-depth", "--max-actions", "--max-actions-per-state",
  "--max-runtime-ms", "--max-agent-calls", "--max-pairs",
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

function reportWasBlocked(report) {
  return report.coverage?.states === 0 && report.coverage?.limit_reason === "viewport_error";
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
        console.error(`Visual QA BLOCKED: ${error.message}`);
        process.exitCode = 2;
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

if (command === "report") {
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
    process.exitCode = report.verdict === "PASS" ? 0 : 1;
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
  let maxPairs = 6;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--max-pairs") maxPairs = Number(args[++i]);
    else if (!arg.startsWith("--")) positional.push(arg);
    else {
      usage();
      process.exit(2);
    }
  }
  try {
    if (!Number.isInteger(maxPairs) || maxPairs < 1)
      throw new Error("--max-pairs must be an integer >= 1");
    if (command === "review-prepare") {
      const [dir] = positional;
      if (!dir) {
        usage();
        process.exit(2);
      }
      const report = JSON.parse(
        await readFile(join(resolve(dir), "report.json"), "utf8"),
      );
      const { file, requests } = await prepareHarnessReview(report, resolve(dir), {
        maxPairs,
      });
      console.log(
        `vision review tasks: ${requests} requests -> ${file}`,
      );
      console.log(
        "hand each request's images + system prompt to your harness vision model, collect {\"results\":[{\"id\",\"findings\"}]}, then: visual-qa review-apply",
      );
      process.exitCode = 0;
    } else {
      const [dir, findingsFile] = positional;
      if (!dir || !findingsFile) {
        usage();
        process.exit(2);
      }
      const result = await applyHarnessReview(resolve(dir), resolve(findingsFile));
      console.log(
        `harness review applied: +${result.accepted} findings (rejected ${result.rejected}) | verdict ${result.verdict} | issues=${result.issues}`,
      );
      console.log(`open report: ${join(resolve(dir), "report.html")}`);
      // Findings are additive and capped: the verdict moved only if medium
      // notes turned PASS into UNPROVEN.
      process.exitCode = 0;
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
    console.log("Demo complete: findings are expected here. Next, run visual-qa against your own URL.");
    // The demo seeds defects on purpose: findings are the success case, so
    // the exit code reports blockage only when the run could not happen.
    process.exitCode = reportWasBlocked(report) ? 2 : 0;
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else if (command === "explore" || command === "run") {
  let baseUrl,
    outDir = ".qa",
    mode = "full",
    isolatedEnvironment = false,
    allowDestructive = false,
    autofix = null,
    fixDir = null,
    intent = null,
    baselineDir = null,
    format = "human",
    outFile = null;
  const bounds = {};
  const changedTargets = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url") baseUrl = args[++i];
    else if (arg === "--out") outDir = args[++i];
    else if (arg === "--mode") mode = args[++i];
    else if (arg === "--isolated") isolatedEnvironment = true;
    else if (arg === "--allow-destructive") allowDestructive = true;
    else if (arg === "--baseline-dir") baselineDir = resolve(args[++i]);
    else if (arg === "--changed-target") changedTargets.push(args[++i]);
    else if (arg === "--autofix") autofix = args[++i];
    else if (arg === "--fix-dir") fixDir = resolve(args[++i]);
    else if (arg === "--intent") intent = args[++i];
    else if (arg === "--format") format = args[++i];
    else if (arg === "--out-file") outFile = args[++i];
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
    else {
      usage();
      process.exit(2);
    }
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
  if (allowDestructive && !isolatedEnvironment) {
    console.error("visual-qa: --allow-destructive requires --isolated");
    process.exit(2);
  }
  try {
    const input = {
      baseUrl,
      outDir: resolve(outDir),
      mode,
      isolatedEnvironment,
      allowDestructive,
      baselineDir,
      changedTargets,
      autofix,
      fixDir,
      intent,
      bounds,
    };
    if (format === "human") {
      const seconds = Math.ceil((bounds.max_runtime_ms ?? 900_000) / 1000);
      console.log(`Visual QA inspect | ${baseUrl ?? "browser disabled"} | budget up to ${seconds}s`);
    }
    const report = command === "run" ? await run(input) : await explore(input);
    await emitResult(report, { format, outDir, outFile });
    process.exitCode = reportWasBlocked(report)
      ? 2
      : report.verdict === "PASS"
        ? 0
        : 1;
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else {
  usage({
    error: true,
    message: command ? `visual-qa: unknown command "${command}"` : "visual-qa: missing command",
  });
  process.exit(2);
}
