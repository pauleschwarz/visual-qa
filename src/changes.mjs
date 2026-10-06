// visual-qa changes: what changed since the branch left its base, and which routes that touches.
// Git change set (commits since the merge-base + staged + unstaged + untracked), glob and
// route_map resolution, and the files that import a changed file.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_BASE_CANDIDATES = ["origin/HEAD", "main", "master"];
export const DEFAULT_IMPORT_DEPTH = 3;
const MAX_BUFFER = 128 * 1024 * 1024;

// ── globs ──────────────────────────────────────────────────────────────────

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

// ── git change set ─────────────────────────────────────────────────────────

function gitRun(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (result.error?.code === "ENOENT")
    throw new Error("git is not installed or not on PATH; agent-run reads what changed from git");
  if (result.error) throw result.error;
  return result;
}

function git(cwd, args) {
  const result = gitRun(cwd, args);
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout || "";
}

const gitOk = (cwd, args) => {
  const result = gitRun(cwd, args);
  return result.status === 0 ? (result.stdout || "").trim() : null;
};

const nulList = (text) => text.split("\0").filter(Boolean);

function assertRepository(cwd) {
  if (gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    throw new Error(
      `${cwd} is not inside a git repository; agent-run reads what changed from git (run it in the project's repository)`,
    );
  if (!gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))
    throw new Error("the git repository has no commits yet; commit once so there is something to compare against");
}

/**
 * The merge-base of HEAD with the base branch. An explicit base must resolve (a wrong base
 * silently shrinks the change set); with none given the candidates are tried in order.
 */
export function resolveDiffBase(cwd, { base, candidates = DEFAULT_BASE_CANDIDATES } = {}) {
  assertRepository(cwd);
  const tried = base ? [base] : candidates;
  for (const ref of tried) {
    if (!gitOk(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) continue;
    const mergeBase = gitOk(cwd, ["merge-base", "HEAD", ref]);
    if (!mergeBase)
      throw new Error(
        `no merge-base between HEAD and ${ref} (shallow clone? run \`git fetch --unshallow\`)`,
      );
    return { ref, merge_base: mergeBase, ref_resolved: gitOk(cwd, ["rev-parse", `${ref}^{commit}`]) };
  }
  throw new Error(
    base
      ? `base "${base}" does not resolve (run \`git fetch\`, or pass another --base <ref>)`
      : `no base branch found (tried ${tried.join(", ")}); pass --base <ref> or set base: in .visual-qa.yml`,
  );
}

/** Output folder of this tool: never a change of the project, even when it is not ignored. */
const insideAny = (file, folders) => folders.some((dir) => file === dir || file.startsWith(`${dir}/`));

/**
 * The branch's change set: merge-base → working tree (committed, staged, unstaged, untracked,
 * not ignored). Paths are relative to `cwd`. A rename lists both paths, a deleted file stays
 * listed. `diff_sha256` binds a report to exactly this state.
 */
export function collectGitState(cwd, { base, candidates, exclude = [] } = {}) {
  const resolved = resolveDiffBase(cwd, { base, candidates });
  const mb = resolved.merge_base;
  const untracked = nulList(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .filter((file) => !insideAny(file, exclude))
    .sort();
  const diff = (...args) => git(cwd, ["diff", "--no-color", "--no-ext-diff", ...args]);
  let material = `${diff(mb)}\n---\n${diff("--cached", mb)}`;
  if (untracked.length) {
    const digest = untracked.map((file) => {
      let body;
      try {
        body = readFileSync(join(cwd, file));
      } catch {
        body = "<unreadable>";
      }
      return `${file} ${createHash("sha256").update(body).digest("hex")}`;
    });
    material += `\n---untracked\n${digest.join("\n")}`;
  }
  const status = nulList(git(cwd, ["diff", "--name-status", "-z", "-M", "--relative", mb]));
  const tracked = [];
  const deleted = [];
  const renamed = [];
  for (let i = 0; i < status.length; ) {
    const code = status[i][0];
    if (code === "R" || code === "C") {
      const [from, to] = [status[i + 1], status[i + 2]];
      if (code === "R") {
        renamed.push({ from, to });
        deleted.push(from);
      }
      tracked.push(from, to);
      i += 3;
    } else {
      if (code === "D") deleted.push(status[i + 1]);
      tracked.push(status[i + 1]);
      i += 2;
    }
  }
  const keep = (list) => list.filter((file) => !insideAny(file, exclude));
  return {
    head: git(cwd, ["rev-parse", "HEAD"]).trim(),
    base_ref: resolved.ref,
    base_resolved: resolved.ref_resolved,
    merge_base: mb,
    diff_sha256: createHash("sha256").update(material).digest("hex"),
    committed_files: keep(nulList(git(cwd, ["diff", "--name-only", "-z", "--relative", mb, "HEAD"]))),
    untracked_files: untracked,
    deleted_files: keep(deleted),
    renamed_files: renamed,
    changed_files: [...new Set([...keep(tracked), ...untracked])],
  };
}

// ── importers ──────────────────────────────────────────────────────────────

const SOURCE_FILE = /\.(tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|css|scss|sass|less)$/i;
const stripExt = (path) => path.replace(SOURCE_FILE, "");

/**
 * Runtime import specifiers of a module: static imports and re-exports, side-effect imports,
 * dynamic imports, require(), CSS @import/@use/@forward. `import type` / `export type` render
 * nothing, so they do not count. Template-literal dynamic imports cannot be followed.
 */
export function importSpecifiers(source) {
  const text = String(source);
  const specs = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s*)?["']([^"']+)["']/g,
  ))
    if (!m[1]) specs.push(m[2]);
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of text.matchAll(/@(?:import|use|forward)\s+(?:url\(\s*)?["']([^"']+)["']/g)) specs.push(m[1]);
  return [...new Set(specs)];
}

/** Project path a specifier names, or null for a package. `aliases`: `{ "@": "src" }`. */
function specifierPath(spec, fromFile, aliases) {
  const bare = spec.replace(/[?#].*$/, "");
  if (bare.startsWith("."))
    return stripExt(posix.normalize(posix.join(posix.dirname(fromFile), bare)));
  for (const [prefix, target] of Object.entries(aliases)) {
    const head = prefix.endsWith("/") ? prefix : `${prefix}/`;
    if (bare === prefix) return stripExt(posix.normalize(target));
    if (bare.startsWith(head))
      return stripExt(posix.normalize(posix.join(target, bare.slice(head.length))));
  }
  return null;
}

/**
 * Who imports whom, built once: `importersOf(file)` names the files (of `files`) that import it.
 * A folder import (`./card`) reaches `card/index.*`.
 */
export function importerIndex(files, readSource, aliases = {}) {
  const importedBy = new Map();
  for (const file of files) {
    const source = readSource(file);
    if (!source) continue;
    for (const spec of importSpecifiers(source)) {
      const path = specifierPath(spec, file, aliases);
      if (path === null) continue;
      if (!importedBy.has(path)) importedBy.set(path, new Set());
      importedBy.get(path).add(file);
    }
  }
  return (target) => {
    const want = stripExt(target);
    const keys = [want];
    if (want.endsWith("/index")) keys.push(want.slice(0, -"/index".length));
    return [...new Set(keys.flatMap((key) => [...(importedBy.get(key) ?? [])]))].filter(
      (file) => file !== target,
    );
  };
}

/** `importersOf(file)` over the project's tracked and untracked sources; deleted files stay unread. */
export function projectImporters(cwd, aliases = {}) {
  const files = nulList(git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).filter(
    (file) => SOURCE_FILE.test(file),
  );
  const readSource = (file) => {
    try {
      return readFileSync(join(cwd, file), "utf8");
    } catch {
      return null;
    }
  };
  return importerIndex(files, readSource, aliases);
}

// ── routes ─────────────────────────────────────────────────────────────────

const keywordOf = (mapping) => (typeof mapping === "string" ? mapping.toUpperCase() : null);

/**
 * Changed UI files → routes, with the reason for each (file → pattern, via the importers).
 * - a route list: those routes;
 * - FULL (alias GLOBAL): the whole app is walked;
 * - IMPORTERS: the files that import the changed file stand in for it, up to `depth` levels
 *   (`importersOf(file)`); a stand-in that matches no entry is passed through. Nothing imports
 *   it → `unrendered`; importers exist but none reaches a mapped file → `unmapped`.
 * `mode: "all"` (default) applies every matching entry per file, `"first"` only the first.
 * Files no entry matches are `unmapped`: tolerated while others resolve, else fail-closed.
 */
export function resolveRoutesFromMap(
  uiFiles,
  routeMap = {},
  { mode = "all", importersOf = () => [], depth = DEFAULT_IMPORT_DEPTH, ignore = [] } = {},
) {
  const entries = Object.entries(routeMap);
  if (!entries.length) return { mode: null, routes: [], reason: "no_route_map" };
  const hitsOf = (file) => {
    const hits = entries.filter(([glob]) => matchGlob(glob, file));
    return mode === "first" ? hits.slice(0, 1) : hits;
  };
  const routes = {};
  const fullReasons = [];
  const unmapped = [];
  const unrendered = [];
  let matched = false;
  let deadEnd = false;

  const record = (mapping, glob, file, via) => {
    const reason = via.length ? { file, pattern: glob, via } : { file, pattern: glob };
    if (keywordOf(mapping) === "FULL" || keywordOf(mapping) === "GLOBAL") fullReasons.push(reason);
    else if (Array.isArray(mapping)) for (const route of mapping) (routes[route] ??= []).push(reason);
    else if (typeof mapping === "string") (routes[mapping] ??= []).push(reason);
  };

  const climb = (origin) => {
    const seen = new Set([origin]);
    let frontier = [{ file: origin, chain: [] }];
    let reached = false;
    let any = false;
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next = [];
      for (const { file, chain } of frontier) {
        for (const importer of importersOf(file)) {
          if (seen.has(importer) || ignore.some((g) => matchGlob(g, importer))) continue;
          seen.add(importer);
          any = true;
          const via = [...chain, importer];
          const hits = hitsOf(importer);
          if (!hits.length) next.push({ file: importer, chain: via });
          for (const [glob, mapping] of hits) {
            if (keywordOf(mapping) === "IMPORTERS") next.push({ file: importer, chain: via });
            else {
              record(mapping, glob, origin, via);
              reached = true;
            }
          }
        }
      }
      frontier = next;
    }
    if (!any) unrendered.push(origin);
    else if (!reached) {
      deadEnd = true;
      unmapped.push(origin);
    }
  };

  for (const file of uiFiles) {
    const hits = hitsOf(file);
    if (!hits.length) {
      unmapped.push(file);
      continue;
    }
    matched = true;
    for (const [glob, mapping] of hits) {
      if (keywordOf(mapping) === "IMPORTERS") climb(file);
      else record(mapping, glob, file, []);
    }
  }

  const detail = { route_reasons: routes, full_reasons: fullReasons, unmapped, unrendered };
  if (fullReasons.length) return { mode: "full", routes: [], reason: null, ...detail };
  if (Object.keys(routes).length)
    return { mode: "changed", routes: Object.keys(routes), reason: null, ...detail };
  if (unrendered.length && !unmapped.length)
    return { mode: "unrendered", routes: [], reason: null, ...detail };
  const reason = !matched || deadEnd ? "no_matching_route_map" : "empty_route_map_match";
  return { mode: null, routes: [], reason, ...detail };
}
