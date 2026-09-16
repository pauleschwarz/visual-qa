// visual-qa agent-run: observe git UI diff, map routes, capture baseline, run QA.
// Observe/compare/evidence only — never apply fixers.

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { captureBaselines } from "./baseline.mjs";
import { resolveDesignContract, designContractMeta } from "./design-contract.mjs";
import { run } from "./run.mjs";

function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Minimal YAML subset for .visual-qa.yml (no dependency). */
export function parseVisualQaYaml(source) {
  const text = String(source ?? "");
  const result = {
    trigger: [],
    ignore: [],
    route_map: {},
    max_review_fix_loops: 2,
  };
  let section = null;
  let currentGlob = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const indent = rawLine.match(/^(\s*)/)[1].length;
    const trimmed = line.trim();

    if (indent === 0) {
      const mapMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (mapMatch) {
        const key = mapMatch[1].trim();
        const rest = mapMatch[2].trim().replace(/^["']|["']$/g, "");
        if (key === "max_review_fix_loops") {
          const n = Number(rest);
          result.max_review_fix_loops =
            Number.isInteger(n) && n > 0 ? n : 2;
          section = null;
          currentGlob = null;
          continue;
        }
        if (!rest) {
          section = key;
          currentGlob = null;
          if (key === "trigger" || key === "ignore") result[key] = result[key] || [];
          if (key === "route_map") result.route_map = result.route_map || {};
        }
        continue;
      }
    }

    if (section === "trigger" || section === "ignore") {
      const item = trimmed.replace(/^-+\s*/, "").replace(/^["']|["']$/g, "");
      if (item) result[section].push(item);
      continue;
    }

    if (section === "route_map") {
      // glob: FULL | glob: or nested list
      const mapMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (mapMatch && !trimmed.startsWith("-")) {
        currentGlob = mapMatch[1].trim().replace(/^["']|["']$/g, "");
        const rest = mapMatch[2].trim().replace(/^["']|["']$/g, "");
        if (rest) {
          if (rest.toUpperCase() === "FULL") result.route_map[currentGlob] = "FULL";
          else result.route_map[currentGlob] = [rest];
        } else {
          result.route_map[currentGlob] = [];
        }
        continue;
      }
      if (trimmed.startsWith("-") && currentGlob) {
        const item = trimmed.replace(/^-+\s*/, "").replace(/^["']|["']$/g, "");
        if (!Array.isArray(result.route_map[currentGlob]))
          result.route_map[currentGlob] = [];
        if (item.toUpperCase() === "FULL") result.route_map[currentGlob] = "FULL";
        else if (item) result.route_map[currentGlob].push(item);
      }
    }
  }
  return result;
}

/** Glob match with * and ** (path segments). */
export function matchGlob(pattern, filePath) {
  const norm = filePath.replaceAll("\\", "/");
  const pat = String(pattern).replaceAll("\\", "/");
  if (pat === norm) return true;
  // ** spans directories; * within a segment
  const escaped = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*");
  return new RegExp(`^${escaped}$`).test(norm);
}

export function filterChangedUiFiles(files, { trigger = [], ignore = [] } = {}) {
  const list = files.map((f) => f.replaceAll("\\", "/"));
  const ignored = (file) => ignore.some((g) => matchGlob(g, file));
  const triggered = (file) =>
    trigger.length === 0
      ? /\.(tsx?|jsx?|css|scss|sass|less|vue|svelte|html)$/i.test(file) ||
        /\/(components?|pages?|app|ui|views?|layouts?)\//i.test(file)
      : trigger.some((g) => matchGlob(g, file));
  return list.filter((f) => !ignored(f) && triggered(f));
}

export function resolveRoutesFromMap(uiFiles, routeMap = {}) {
  const entries = Object.entries(routeMap);
  if (!entries.length) {
    return { mode: null, routes: [], reason: "no_route_map" };
  }
  const routes = new Set();
  let full = false;
  let matched = false;
  for (const file of uiFiles) {
    for (const [glob, mapping] of entries) {
      if (!matchGlob(glob, file)) continue;
      matched = true;
      if (mapping === "FULL" || mapping === "full") {
        full = true;
      } else if (Array.isArray(mapping)) {
        for (const route of mapping) routes.add(route);
      } else if (typeof mapping === "string") {
        routes.add(mapping);
      }
    }
  }
  if (!matched) return { mode: null, routes: [], reason: "no_matching_route_map" };
  if (full) return { mode: "full", routes: [], reason: null };
  if (!routes.size)
    return { mode: null, routes: [], reason: "empty_route_map_match" };
  return { mode: "changed", routes: [...routes], reason: null };
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return (result.stdout || "").trim();
}

export function collectGitState(cwd, gitRef = "HEAD") {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const refResolved = git(cwd, ["rev-parse", gitRef]);
  const diffName = git(cwd, [
    "diff",
    "--name-only",
    `${gitRef}`,
    "--",
  ]);
  // Include unstaged + staged vs ref: diff ref + untracked is complex;
  // agent-run uses working tree vs gitRef (diff + cached names against ref).
  const vsRef = git(cwd, ["diff", "--name-only", gitRef]);
  const cached = git(cwd, ["diff", "--name-only", "--cached", gitRef]);
  const files = [
    ...new Set(
      [...vsRef.split("\n"), ...cached.split("\n"), ...diffName.split("\n")]
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  const fullDiff = git(cwd, ["diff", gitRef]);
  const cachedDiff = git(cwd, ["diff", "--cached", gitRef]);
  const diffSha = sha256Hex(`${fullDiff}\n---\n${cachedDiff}`);
  return {
    head,
    git_ref: gitRef,
    git_ref_resolved: refResolved,
    diff_sha256: diffSha,
    changed_files: files,
  };
}

export async function loadVisualQaConfig(projectRoot) {
  const path = join(resolve(projectRoot), ".visual-qa.yml");
  if (!(await exists(path))) {
    return {
      path: null,
      config: { trigger: [], ignore: [], route_map: {}, max_review_fix_loops: 2 },
    };
  }
  const source = await readFile(path, "utf8");
  return { path, config: parseVisualQaYaml(source) };
}

/**
 * Main agent-run entry. Returns a structured result; writes report under outDir.
 */
export async function agentRun({
  url,
  baselineUrl = null,
  outDir = ".qa-agent",
  projectRoot = process.cwd(),
  gitRef = "HEAD",
  designContractPath = null,
  bounds = undefined,
  viewports = undefined,
} = {}) {
  if (!url) throw new Error("agent-run requires --url");
  const root = resolve(projectRoot);
  const out = resolve(outDir);
  await mkdir(out, { recursive: true });

  const gitState = collectGitState(root, gitRef);
  const { path: configPath, config } = await loadVisualQaConfig(root);
  const uiFiles = filterChangedUiFiles(gitState.changed_files, config);

  const design = await resolveDesignContract({
    explicitPath: designContractPath,
    projectRoot: root,
  });

  const agentMeta = {
    schema_version: "vqa-agent-run-0.1",
    project_root: root,
    config_path: configPath,
    git: {
      head: gitState.head,
      ref: gitState.git_ref,
      ref_resolved: gitState.git_ref_resolved,
      diff_sha256: gitState.diff_sha256,
      changed_files: gitState.changed_files,
      ui_files: uiFiles,
    },
    design_contract: designContractMeta(design),
    noop: false,
    mode: null,
    routes: [],
    policy: {
      max_review_fix_loops: Number.isInteger(config.max_review_fix_loops)
        ? config.max_review_fix_loops
        : 2,
      applies_fixers: false,
    },
    review_fix_loops: 0,
    fixer_applied: false,
  };

  if (uiFiles.length === 0) {
    agentMeta.noop = true;
    agentMeta.reason = "no_ui_diff";
    const report = {
      schema_version: "vqa-0.1",
      product: "Visual QA",
      run_id: "agent-noop",
      started_at: new Date().toISOString(),
      duration_ms: 0,
      verdict: "PASS",
      complete: true,
      mode: "off",
      coverage: {
        states: 0,
        actions: 0,
        limit_reason: null,
        vision_required: false,
        vision_complete: true,
      },
      issues: [],
      evidence: [],
      phases: { agent_run: { status: "noop", reason: "no_ui_diff" } },
      agent_run: agentMeta,
      design_contract: designContractMeta(design),
    };
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(
      join(out, "agent-run.json"),
      `${JSON.stringify(agentMeta, null, 2)}\n`,
    );
    return { ok: true, noop: true, report, outDir: out, agent: agentMeta };
  }

  const routeResolution = resolveRoutesFromMap(uiFiles, config.route_map);
  if (!routeResolution.mode) {
    agentMeta.reason = routeResolution.reason || "route_map_required";
    const report = {
      schema_version: "vqa-0.1",
      product: "Visual QA",
      run_id: "agent-fail",
      started_at: new Date().toISOString(),
      duration_ms: 0,
      verdict: "FAIL",
      complete: false,
      mode: "off",
      coverage: {
        states: 0,
        actions: 0,
        limit_reason: "agent_run_no_route_map",
        vision_required: false,
        vision_complete: false,
      },
      issues: [
        {
          issue_id: "vqa-agent-run-no-route-map",
          type: "vqa-agent-run",
          title: "UI diff without route map",
          severity: "high",
          detail:
            "Changed UI files require .visual-qa.yml route_map entries; fail-closed.",
          evidence: {
            ui_files: uiFiles,
            reason: routeResolution.reason,
          },
        },
      ],
      evidence: [],
      phases: { agent_run: { status: "failed", reason: routeResolution.reason } },
      agent_run: agentMeta,
      design_contract: designContractMeta(design),
    };
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(
      join(out, "agent-run.json"),
      `${JSON.stringify({ ...agentMeta, failed: true }, null, 2)}\n`,
    );
    return { ok: false, noop: false, report, outDir: out, agent: agentMeta };
  }

  agentMeta.mode = routeResolution.mode;
  agentMeta.routes = routeResolution.routes;

  const baselineDir = join(out, "baselines");
  if (baselineUrl) {
    const targets =
      routeResolution.mode === "full"
        ? ["/"]
        : routeResolution.routes.length
          ? routeResolution.routes
          : ["/"];
    await captureBaselines({
      baseUrl: baselineUrl,
      outDir: baselineDir,
      targets,
      viewports,
    });
    agentMeta.baseline = {
      url: baselineUrl,
      dir: baselineDir,
      targets,
    };
  }

  const runInput = {
    baseUrl: url,
    outDir: out,
    mode: routeResolution.mode,
    baselineDir: baselineUrl ? baselineDir : undefined,
    designContract: design,
    designContractPath: design?.path,
    agentRun: agentMeta,
    prepareReview: true,
    autofix: false,
    bounds,
    viewports,
  };
  if (routeResolution.mode === "changed") {
    runInput.changedTargets = routeResolution.routes;
  }

  const report = await run(runInput);
  // run() owns phase-level agent metadata; preserve it while binding the
  // durable git/design receipt captured before the walk.
  report.agent_run = { ...(report.agent_run || {}), ...agentMeta };
  report.design_contract = designContractMeta(design) ?? report.design_contract;

  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    join(out, "agent-run.json"),
    `${JSON.stringify(agentMeta, null, 2)}\n`,
  );

  return {
    ok: report.verdict === "PASS" && report.complete,
    noop: false,
    report,
    outDir: out,
    agent: agentMeta,
  };
}

