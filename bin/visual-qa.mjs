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

function usage() {
  console.error(
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

/**
 * Print or persist the run result in the requested format. json goes to
 * stdout (harness consumption), junit to a file when --out-file is given,
 * otherwise to stdout (CI systems ingest it directly).
 */
function emitResult(report, { format, outDir, outFile }) {
  if (format === "json") {
    console.log(JSON.stringify(summarizeReport(report), null, 2));
    return;
  }
  if (format === "junit") {
    const xml = renderJunitXml(report);
    if (outFile) {
      const path = resolve(outFile);
      writeFile(path, xml)
        .then(() => console.log(`junit report: ${path}`))
        .catch((error) => {
          console.error(`Visual QA BLOCKED: ${error.message}`);
          process.exitCode = 2;
        });
    } else {
      console.log(xml);
    }
    return;
  }
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
  console.log(`full report: ${join(resolve(outDir), "report.md")}`);
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
  if (!intents.length) {
    usage();
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
      console.log(`full report: ${join(resolve(dir), "report.md")}`);
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
    if (!["human", "json", "junit"].includes(format)) {
      console.error(`visual-qa: unknown --format "${format}"`);
      process.exit(2);
    }
    emitResult(report, { format, outDir, outFile });
    process.exitCode = report.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(`Visual QA BLOCKED: ${error.message}`);
    process.exitCode = 2;
  }
} else {
  usage();
  process.exit(2);
}
