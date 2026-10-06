// visual-qa agent-run: observe git UI diff, map routes, capture baseline, run QA.
// Observe/compare/evidence only — never apply fixers.

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { withAppServer } from "./app-server.mjs";
import { captureBaselines } from "./baseline.mjs";
import {
  collectGitState,
  DEFAULT_IMPORT_DEPTH,
  filterChangedUiFiles,
  matchGlob,
  projectImporters,
  resolveRoutesFromMap,
} from "./changes.mjs";
import { resolveDesignContract, designContractMeta } from "./design-contract.mjs";
import { run } from "./run.mjs";
import { resolveSessionInput, splitStateRoutes } from "./session.mjs";
import { exists } from "./files.mjs";

const KNOWN_KEYS = new Set([
  "trigger",
  "ignore",
  "route_map",
  "max_review_fix_loops",
  "setup",
  "storage_state",
  "states",
  "journeys",
  "base",
  "route_map_mode",
  "import_depth",
  "aliases",
  "server",
]);
const KNOWN_SERVER_KEYS = new Set(["command", "health", "startup_timeout_ms"]);
const ROUTE_MAP_MODES = new Set(["all", "first"]);
const KNOWN_STATE_KEYS = new Set([
  "path",
  "setup",
  "expect_api",
  "fail_api",
  "reason",
  "fresh",
]);
const KNOWN_JOURNEY_KEYS = new Set(["file", "fresh"]);

/** route_map values that are not a route list: FULL (alias GLOBAL) walks the whole app, IMPORTERS follows the importers. */
function routeMapKeyword(text) {
  const upper = String(text).toUpperCase();
  if (upper === "FULL" || upper === "GLOBAL") return "FULL";
  return upper === "IMPORTERS" ? "IMPORTERS" : null;
}

function emptyConfig() {
  return {
    trigger: [],
    ignore: [],
    route_map: {},
    baseline: {},
    max_review_fix_loops: 2,
    setup: null,
    storage_state: null,
    states: {},
    journeys: {},
    base: null,
    route_map_mode: "all",
    import_depth: DEFAULT_IMPORT_DEPTH,
    aliases: {},
    server: null,
    warnings: [],
  };
}

// '#' opens a comment only outside quotes and after whitespace, so globs and
// URL fragments ("**/api#x", "/#/orders") survive in quoted values.
function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s:,-]/.test(line[i - 1]))) {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function yamlScalar(raw, lineNo) {
  const text = raw.trim();
  if (/^[[{]/.test(text))
    throw new Error(
      `.visual-qa.yml line ${lineNo}: inline {…}/[…] is not supported; use an indented block`,
    );
  const quoted = text.match(/^(["'])(.*)\1$/);
  if (quoted) return quoted[2];
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  return text;
}

// "key: rest" with an optionally quoted key (globs contain ':' and '*').
function yamlKeyValue(text, lineNo) {
  const quoted = text.match(/^(["'])(.*?)\1\s*:(?:\s+(.*))?$/);
  if (quoted) return [quoted[2], quoted[3] ?? ""];
  const plain = text.match(/^([^:]+?)\s*:(?:\s+(.*))?$/);
  if (!plain)
    throw new Error(`.visual-qa.yml line ${lineNo}: expected "key: value"`);
  return [plain[1].trim(), plain[2] ?? ""];
}

/** Indented block of "key: value" maps / "- item" lists below one top-level key. */
function parseYamlBlock(lines, index, indent) {
  const first = lines[index];
  if (first.text.startsWith("- ") || first.text === "-") {
    const list = [];
    while (index < lines.length && lines[index].indent === indent) {
      list.push(yamlScalar(lines[index].text.replace(/^-\s*/, ""), lines[index].no));
      index += 1;
    }
    return [list, index];
  }
  const map = {};
  while (index < lines.length && lines[index].indent >= indent) {
    const line = lines[index];
    if (line.indent !== indent)
      throw new Error(`.visual-qa.yml line ${line.no}: unexpected indentation`);
    const [key, rest] = yamlKeyValue(line.text, line.no);
    index += 1;
    if (rest.trim()) {
      map[key] = yamlScalar(rest, line.no);
    } else if (index < lines.length && lines[index].indent > indent) {
      [map[key], index] = parseYamlBlock(lines, index, lines[index].indent);
    } else {
      map[key] = {};
    }
  }
  return [map, index];
}

function parseScalarKey(key, rest, lineNo, result) {
  const value = rest.trim() ? yamlScalar(rest, lineNo) : null;
  if (key === "base") {
    result.base = value === null || value === "" ? null : String(value);
  } else if (key === "route_map_mode") {
    if (ROUTE_MAP_MODES.has(value)) result.route_map_mode = value;
    else result.warnings.push(`route_map_mode "${value}" is not all or first (using all)`);
  } else if (Number.isInteger(value) && value > 0) {
    result.import_depth = value;
  } else {
    result.warnings.push(`import_depth "${value}" is not a positive integer (using ${DEFAULT_IMPORT_DEPTH})`);
  }
}

function setAliases(block, result) {
  for (const [prefix, target] of Object.entries(block)) {
    if (typeof target === "string" && target) result.aliases[prefix] = target;
    else result.warnings.push(`aliases.${prefix} is not a path (ignored)`);
  }
}

function setServer(block, result) {
  for (const field of Object.keys(block))
    if (!KNOWN_SERVER_KEYS.has(field))
      result.warnings.push(`unknown key "${field}" in server (ignored)`);
  const text = (value) => (typeof value === "string" && value.trim() ? value : null);
  if (!text(block.command) || !text(block.health))
    throw new Error(".visual-qa.yml: server needs both command and health");
  const timeout = block.startup_timeout_ms;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0))
    throw new Error(".visual-qa.yml: server.startup_timeout_ms must be a positive integer");
  result.server = { command: block.command, health: block.health };
  if (timeout !== undefined) result.server.startup_timeout_ms = timeout;
}

/** Top-level keys of the new session sections, parsed on their own so older files keep their exact behaviour. */
function parseSessionSections(text, result) {
  const lines = [];
  let topKey = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const stripped = stripYamlComment(raw);
    if (!stripped.trim()) return;
    if (/^\s*\t/.test(stripped)) {
      // Older sections (trigger, route_map, …) accepted tabs; only the new ones refuse them.
      if (["states", "journeys", "aliases", "server"].includes(topKey))
        throw new Error(`.visual-qa.yml line ${i + 1}: tabs are not allowed`);
      return;
    }
    if (!/^\s/.test(stripped) && !stripped.startsWith("-"))
      topKey = stripped.match(/^["']?([^:"']+)/)?.[1].trim() ?? null;
    lines.push({
      no: i + 1,
      indent: stripped.match(/^ */)[0].length,
      text: stripped.trim(),
    });
  });
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    // Older files keep list items at column 0 or carry lines this parser does
    // not own; only a real "key:" line opens a section.
    if (line.indent !== 0 || line.text.startsWith("-") || !/^["']?[^:]+["']?\s*:/.test(line.text)) {
      i += 1;
      continue;
    }
    const [key, rest] = yamlKeyValue(line.text, line.no);
    i += 1;
    if (!KNOWN_KEYS.has(key)) {
      result.warnings.push(`unknown key "${key}" in .visual-qa.yml (ignored)`);
      continue;
    }
    if (key === "setup" || key === "storage_state") {
      result[key] = rest.trim() ? String(yamlScalar(rest, line.no)) : null;
    } else if (key === "base" || key === "route_map_mode" || key === "import_depth") {
      parseScalarKey(key, rest, line.no, result);
    } else if (key === "aliases" || key === "server") {
      if (rest.trim())
        throw new Error(
          `.visual-qa.yml line ${line.no}: ${key} must be an indented block, not "${rest.trim()}"`,
        );
      if (i < lines.length && lines[i].indent > 0) {
        let block;
        [block, i] = parseYamlBlock(lines, i, lines[i].indent);
        if (key === "aliases") setAliases(block, result);
        else setServer(block, result);
      }
    } else if (key === "states" || key === "journeys") {
      if (rest.trim()) {
        yamlScalar(rest, line.no);
        throw new Error(
          `.visual-qa.yml line ${line.no}: ${key} must be an indented block of named entries, not "${rest.trim()}"`,
        );
      }
      if (i < lines.length && lines[i].indent > 0) {
        let block;
        [block, i] = parseYamlBlock(lines, i, lines[i].indent);
        result[key] = block;
      }
    }
  }
  const knownKeys = { states: KNOWN_STATE_KEYS, journeys: KNOWN_JOURNEY_KEYS };
  for (const section of ["states", "journeys"]) {
    for (const [name, def] of Object.entries(result[section])) {
      if (section === "journeys" && typeof def === "string") continue;
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        result.warnings.push(`${section}.${name} is not a mapping (ignored)`);
        result[section][name] = {};
        continue;
      }
      for (const field of Object.keys(def))
        if (!knownKeys[section].has(field))
          result.warnings.push(
            `unknown key "${field}" in ${section}.${name} (ignored)`,
          );
    }
  }
}

/** Minimal YAML subset for .visual-qa.yml (no dependency). */
export function parseVisualQaYaml(source) {
  const text = String(source ?? "");
  const result = emptyConfig();
  let section = null;
  let currentGlob = null;
  let baselineKey = null;

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

    if (section === "baseline") {
      // baseline: routes / viewports as lists (viewport "name: 390x844"), the rest scalars.
      const unquote = (v) => v.trim().replace(/^["']|["']$/g, "");
      if (trimmed.startsWith("-") && baselineKey) {
        const item = unquote(trimmed.replace(/^-+\s*/, ""));
        const named = /^([^:\s]+):\s*(\d+x\d+)$/i.exec(item);
        if (item) result.baseline[baselineKey].push(named ? `${named[1]}=${named[2]}` : item);
        continue;
      }
      const pair = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!pair) continue;
      baselineKey = pair[1].trim();
      const rest = pair[2].trim();
      if (!rest) result.baseline[baselineKey] = [];
      else if (rest.startsWith("["))
        result.baseline[baselineKey] = rest
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(unquote)
          .filter(Boolean);
      else result.baseline[baselineKey] = unquote(rest);
      continue;
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
          if (routeMapKeyword(rest)) result.route_map[currentGlob] = routeMapKeyword(rest);
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
        if (routeMapKeyword(item)) result.route_map[currentGlob] = routeMapKeyword(item);
        else if (item) result.route_map[currentGlob].push(item);
      }
    }
  }
  parseSessionSections(text, result);
  return result;
}

export { collectGitState, filterChangedUiFiles, matchGlob, resolveRoutesFromMap };

/** The config's route_map, route_map_mode, import_depth, aliases and ignore applied to the changed UI files. */
export function resolveChangedRoutes(uiFiles, config, root) {
  return resolveRoutesFromMap(uiFiles, config.route_map, {
    mode: config.route_map_mode,
    depth: config.import_depth,
    ignore: config.ignore,
    importersOf: Object.values(config.route_map).includes("IMPORTERS")
      ? projectImporters(root, config.aliases)
      : undefined,
  });
}

export async function loadVisualQaConfig(projectRoot, explicitFile = null) {
  const path = explicitFile
    ? resolve(explicitFile)
    : join(resolve(projectRoot), ".visual-qa.yml");
  if (!(await exists(path))) {
    if (explicitFile) throw new Error(`config file not found: ${path}`);
    return { path: null, config: emptyConfig() };
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
  base = null,
  gitRef = null,
  designContractPath = null,
  bounds = undefined,
  viewports = undefined,
} = {}) {
  const root = resolve(projectRoot);
  const out = resolve(outDir);
  const { path: configPath, config } = await loadVisualQaConfig(root);
  // Without --url the app is the one `server.health` answers on.
  url ??= config.server ? new URL(config.server.health).origin : null;
  if (!url) throw new Error("agent-run requires --url (or a server: block in .visual-qa.yml)");
  await mkdir(out, { recursive: true });

  // --base beats base: in the config; --git-ref is the older name of --base.
  const outRelative = relative(realpathSync(root), realpathSync(out)).replaceAll("\\", "/");
  const gitState = collectGitState(root, {
    base: base ?? gitRef ?? config.base ?? undefined,
    exclude: outRelative && !outRelative.startsWith("..") ? [outRelative] : [],
  });
  const uiFiles = filterChangedUiFiles(gitState.changed_files, config);

  const design = await resolveDesignContract({
    explicitPath: designContractPath,
    projectRoot: root,
  });

  const agentMeta = {
    schema_version: "vqa-agent-run-0.1",
    project_root: root,
    config_path: configPath,
    config_warnings: config.warnings ?? [],
    git: {
      head: gitState.head,
      ref: gitState.base_ref,
      ref_resolved: gitState.base_resolved,
      merge_base: gitState.merge_base,
      diff_sha256: gitState.diff_sha256,
      committed_files: gitState.committed_files,
      untracked_files: gitState.untracked_files,
      deleted_files: gitState.deleted_files,
      renamed_files: gitState.renamed_files,
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

  const routeResolution = uiFiles.length ? resolveChangedRoutes(uiFiles, config, root) : null;
  if (routeResolution) {
    agentMeta.route_reasons = routeResolution.route_reasons ?? {};
    agentMeta.full_reasons = routeResolution.full_reasons ?? [];
    agentMeta.unmapped_files = routeResolution.unmapped ?? [];
    agentMeta.unrendered_files = routeResolution.unrendered ?? [];
  }
  // Nothing to look at: no UI file changed, or the changed files are imported by nothing.
  const noopReason = !routeResolution
    ? "no_ui_diff"
    : routeResolution.mode === "unrendered"
      ? "unrendered"
      : null;

  if (noopReason) {
    agentMeta.noop = true;
    agentMeta.reason = noopReason;
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
      phases: { agent_run: { status: "noop", reason: noopReason } },
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
  // "path@state" routes capture a named state (sign-in, injected failure);
  // plain routes keep the declared-target walk.
  const split = splitStateRoutes(routeResolution.routes, config.states);
  agentMeta.states = split.states;
  const sessionInput = split.states.length
    ? await resolveSessionInput(config, {
        baseDir: dirname(configPath),
        states: split.states,
      })
    : {};

  const baselineDir = join(out, "baselines");
  if (baselineUrl) {
    const targets =
      routeResolution.mode === "full"
        ? ["/"]
        : split.plain.length
          ? split.plain
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

  const stateOnly =
    routeResolution.mode === "changed" && split.plain.length === 0;
  const runInput = {
    ...sessionInput,
    baseUrl: url,
    outDir: out,
    // Named states alone narrow the run; "changed" needs a plain target.
    mode: stateOnly ? "full" : routeResolution.mode,
    baselineDir: baselineUrl ? baselineDir : undefined,
    designContract: design,
    designContractPath: design?.path,
    agentRun: agentMeta,
    prepareReview: true,
    autofix: false,
    bounds,
    viewports,
  };
  if (routeResolution.mode === "changed" && !stateOnly) {
    runInput.changedTargets = split.plain;
  }

  // The project's own server runs only while the walk does, and is stopped on every way out.
  const report = config.server
    ? await withAppServer(config.server, () => run(runInput), { cwd: root })
    : await run(runInput);
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

