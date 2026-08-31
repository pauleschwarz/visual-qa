#!/usr/bin/env node
import { resolve } from "node:path";
import { explore } from "../src/explore.mjs";
import { run } from "../src/run.mjs";

function usage() {
  console.error(
    "Usage:\n" +
      "  visual-qa run --url URL [--out DIR] [--isolated] [--autofix verified] [--fix-dir DIR]\n" +
      "                 [--intent \"instruction\"] [--max-agent-calls N] [--mode off|changed|full] [bounds flags]\n" +
      "  visual-qa explore --url URL [--out DIR] [--mode off|changed|full] [bounds flags]\n" +
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
  console.log(
    createRequire(import.meta.url)("../package.json").version,
  );
  process.exit(0);
}
const command = args.shift();
if (command !== "explore" && command !== "run") {
  usage();
  process.exit(2);
}
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
  console.error("visual-qa: --mode changed requires at least one --changed-target");
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
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
} catch (error) {
  console.error(`Visual QA BLOCKED: ${error.message}`);
  process.exitCode = 2;
}
