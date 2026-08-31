#!/usr/bin/env node
import { resolve } from "node:path";
import { explore } from "../src/explore.mjs";
import { run } from "../src/run.mjs";

function usage() {
  console.error(
    "Usage:\n" +
      "  visual-qa run --url URL [--out DIR] [--isolated] [--autofix verified] [--fix-dir DIR]\n" +
      "                 [--max-agent-calls N] [--mode off|changed|full] [bounds flags]\n" +
      "  visual-qa explore --url URL [--out DIR] [bounds flags]   # deterministic core only\n" +
      "Bounds flags: --max-states N --max-depth N --max-actions N --max-actions-per-state N --max-runtime-ms N",
  );
  process.exitCode = 2;
}
const args = process.argv.slice(2);
const command = args.shift();
if (command !== "explore" && command !== "run") {
  usage();
  process.exit(2);
}
let baseUrl,
  outDir = ".qa",
  mode = "full",
  isolatedEnvironment = false,
  autofix = null,
  fixDir = null;
const bounds = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--url") baseUrl = args[++i];
  else if (arg === "--out") outDir = args[++i];
  else if (arg === "--mode") mode = args[++i];
  else if (arg === "--isolated") isolatedEnvironment = true;
  else if (arg === "--autofix") autofix = args[++i];
  else if (arg === "--fix-dir") fixDir = resolve(args[++i]);
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
if (!baseUrl) {
  usage();
  process.exit(2);
}
try {
  const input = {
    baseUrl,
    outDir: resolve(outDir),
    mode,
    isolatedEnvironment,
    autofix,
    fixDir,
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
