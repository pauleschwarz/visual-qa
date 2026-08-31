#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { demo } from "../src/demo.mjs";
import { explore } from "../src/explore.mjs";
import { renderSummaryLines, summarizeReport } from "../src/report.mjs";
import { run } from "../src/run.mjs";

function usage() {
  console.error(
    "Usage:\n" +
      "  visual-qa demo [--out DIR] [bounds flags]              zero-setup first run\n" +
      "  visual-qa run --url URL [--out DIR] [--isolated] [--autofix verified] [--fix-dir DIR]\n" +
      "                 [--intent \"instruction\"] [--max-agent-calls N] [--mode off|changed|full] [bounds flags]\n" +
      "  visual-qa explore --url URL [--out DIR] [bounds flags]  deterministic core only\n" +
      "  visual-qa report <DIR> [--json]                         summarize an out-dir for agents\n" +
      "Mode flags:   --changed-target URL (repeatable, required for --mode changed)\n" +
      "              --baseline-dir DIR (per-viewport <name>.png baselines)\n" +
      "              --allow-destructive (only with --isolated)\n" +
      "Bounds flags: --max-states N --max-depth N --max-actions N --max-actions-per-state N --max-runtime-ms N",
  );
  process.exitCode = 2;
}
const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-v") {
  const { createRequire } = await import("node:module");
  console.log(createRequire(import.meta.url)("../package.json").version);
  process.exit(0);
}
const command = args.shift();
if (command === "report") {
  const dir = args[0] && !args[0].startsWith("--") ? args.shift() : null;
  const json = args.includes("--json");
  const unknown = args.filter((a) => a !== "--json");
  if (!dir || unknown.length) {
    usage();
    process.exit(2);
  }
  try {
    const report = JSON.parse(await readFile(join(resolve(dir), "report.json"), "utf8"));
    const summary = summarizeReport(report);
    if (json) console.log(JSON.stringify(summary, null, 2));
    else console.log(renderSummaryLines(summary).join("\n"));
    process.exitCode = report.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else if (command === "demo") {
  let outDir = ".qa-demo";
  const bounds = {};
  const flagValues = { "--out": outDir };
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
  void flagValues;
  try {
    const report = await demo({ outDir: resolve(outDir), bounds });
    console.log(
      `Visual QA ${report.verdict} | states=${report.coverage.states} actions=${report.coverage.actions} issues=${report.issues.length}`,
    );
    if (report.coverage.limit_reason)
      console.log(`coverage incomplete: ${report.coverage.limit_reason}`);
    for (const issue of report.issues.slice(0, 12))
      console.log(
        `${issue.severity.toUpperCase()} ${issue.issue_id}: ${issue.title}`,
      );
    console.log(`full report: ${resolve(outDir)}/report.md`);
    // The demo seeds defects on purpose: findings are the success case, so
    // the exit code reports blockage only when the run could not happen.
    process.exitCode = 0;
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
    baselineDir = null;
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
    const report = command === "run" ? await run(input) : await explore(input);
    console.log(
      `Visual QA ${report.verdict} | states=${report.coverage.states} actions=${report.coverage.actions} issues=${report.issues.length}`,
    );
    for (const [phase, info] of Object.entries(report.phases || {}))
      console.log(`  ${phase}: ${JSON.stringify(info)}`);
    if (report.coverage.limit_reason)
      console.log(`coverage incomplete: ${report.coverage.limit_reason}`);
    for (const issue of report.issues.slice(0, 12))
      console.log(
        `${issue.severity.toUpperCase()} ${issue.issue_id}: ${issue.title}`,
      );
    console.log(`full report: ${resolve(outDir)}/report.md`);
    process.exitCode = report.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else {
  usage();
  process.exit(2);
}
