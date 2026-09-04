// Visual QA - human-readable report aggregation.
//
// report.json is the machine contract. report.md and report.html are portable
// human views of that same redacted result.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./config.mjs";

const SEVERITIES = ["critical", "high", "medium", "low"];
const SEVERITY_RANK = new Map(
  SEVERITIES.map((severity, index) => [severity, index]),
);

function orderedIssues(issues = []) {
  return [...issues].sort(
    (a, b) =>
      (SEVERITY_RANK.get(a.severity) ?? SEVERITIES.length) -
      (SEVERITY_RANK.get(b.severity) ?? SEVERITIES.length),
  );
}

/**
 * The machine summary agents consume: verdict, counts, the top findings,
 * and where the full evidence lives. Deliberately small - an agent wants
 * the next actions, not the whole report.
 */
export function summarizeReport(report) {
  const issues = orderedIssues(report.issues || []);
  const bySeverity = {};
  for (const issue of issues)
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
  return {
    verdict: report.verdict,
    run_id: report.run_id ?? null,
    complete: report.complete ?? null,
    limit_reason: report.coverage?.limit_reason ?? null,
    coverage: {
      states: report.coverage?.states ?? 0,
      actions: report.coverage?.actions ?? 0,
      viewports: report.coverage?.viewports_covered ?? [],
    },
    issue_count: issues.length,
    by_severity: bySeverity,
    issues: issues.slice(0, 10).map((issue) => ({
      id: issue.issue_id,
      type: issue.type,
      severity: issue.severity,
      title: issue.title,
      detail: issue.detail,
    })),
    phases: report.phases ?? {},
    artifacts: {
      report_json: "report.json",
      report_md: "report.md",
      report_html: "report.html",
      screenshots: "screenshots/",
      vision: "vision/",
      fixes: "fixes/",
      intent: "intent/",
      verify: "verify/",
    },
  };
}

export function renderSummaryLines(summary) {
  const lines = [];
  lines.push(`Visual QA ${summary.verdict} | issues=${summary.issue_count}`);
  if (summary.limit_reason)
    lines.push(`coverage limit: ${summary.limit_reason}`);
  for (const [phase, info] of Object.entries(summary.phases || {}))
    lines.push(`  ${phase}: ${JSON.stringify(info)}`);
  for (const issue of summary.issues)
    lines.push(`${issue.severity.toUpperCase()} ${issue.id}: ${issue.title}`);
  return lines;
}

function truncate(text, max = 160) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push("# Visual QA Report");
  lines.push("");
  lines.push(`**Verdict:** \`${report.verdict}\``);
  if (report.coverage?.limit_reason)
    lines.push(`**Coverage limit:** \`${report.coverage.limit_reason}\``);
  lines.push(
    `**Coverage:** ${report.coverage?.states ?? 0} states, ${report.coverage?.actions ?? 0} actions over ${(report.coverage?.viewports_covered || []).join(", ") || "no viewports"}`,
  );
  lines.push(`**Duration:** ${Math.round((report.duration_ms || 0) / 1000)}s`);
  lines.push("");

  const phases = report.phases || {};
  const phaseLines = [];
  if (report.run_id) phaseLines.push(`- run: \`${report.run_id}\``);
  if (phases.intent)
    phaseLines.push(
      `- intent: parsed=${phases.intent.parsed}, applied=${phases.intent.applied ?? false}${phases.intent.reason ? `, reason: ${phases.intent.reason}` : ""}${phases.intent.parsed === false ? ` — ${phases.intent.detail}` : ""}`,
    );
  if (phases.vision)
    phaseLines.push(
      `- vision: \`${phases.vision.status}\` — ${phases.vision.issues ?? 0} finding(s)`,
    );
  if (phases.fix)
    phaseLines.push(
      `- fix: ${phases.fix.applied?.length ?? 0} applied${phases.fix.skipped?.length ? `, skipped: ${phases.fix.skipped.map((entry) => (typeof entry === "string" ? entry : `${entry.kind}:${entry.reason}`)).join(", ")}` : ""}`,
    );
  if (phases.verify)
    phaseLines.push(
      `- verify: \`${phases.verify.verdict}\` — ${phases.verify.fixed} fixed, ${phases.verify.remaining} remaining`,
    );
  if (phaseLines.length) {
    lines.push("## Phases");
    lines.push("");
    lines.push(...phaseLines);
    lines.push("");
  }

  const issues = orderedIssues(report.issues || []);
  if (!issues.length) {
    lines.push("## Issues");
    lines.push("");
    lines.push("None. A `COVERAGE_INCOMPLETE` run is still not a pass.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`## Issues (${issues.length})`);
  lines.push("");
  for (const severity of SEVERITIES) {
    const group = issues.filter((issue) => issue.severity === severity);
    if (!group.length) continue;
    lines.push(`### ${severity.toUpperCase()}`);
    lines.push("");
    lines.push("| ID | Type | Title | Detail |");
    lines.push("| --- | --- | --- | --- |");
    for (const issue of group) {
      lines.push(
        `| \`${issue.issue_id}\` | \`${issue.type}\` | ${truncate(issue.title, 90)} | ${truncate(issue.detail, 140)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function artifactHref(path) {
  const normalized = String(path ?? "").replaceAll("\\", "/");
  const marker = "/screenshots/";
  const markerIndex = normalized.lastIndexOf(marker);
  const relative =
    markerIndex >= 0
      ? normalized.slice(markerIndex + 1)
      : normalized.startsWith("screenshots/")
        ? normalized
        : null;
  if (!relative || relative.includes("..")) return null;
  return `./${relative.split("/").map(encodeURIComponent).join("/")}`;
}

function screenshotPairs(report) {
  const seen = new Set();
  const pairs = [];
  for (const entry of report.evidence || []) {
    const before = artifactHref(entry?.before?.screenshot);
    const after = artifactHref(entry?.after?.screenshot);
    if (!before || !after) continue;
    const key = `${before}|${after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      before,
      after,
      label: entry?.control?.name || entry?.action_id || "Observed action",
    });
    if (pairs.length === 12) break;
  }
  return pairs;
}

function verdictMessage(report) {
  if (report.verdict === "PASS") return "Complete walk. No blocking findings.";
  if (report.verdict === "FAIL")
    return "The walk completed and found ship blockers.";
  if (report.verdict === "UNPROVEN")
    return "Notes remain. This is not a ship-gate pass.";
  return "Coverage stopped before the surface was fully proven.";
}

/** Render a self-contained inspection docket with no network dependencies. */
export function renderHtmlReport(report) {
  const issues = orderedIssues(report.issues || []);
  const pairs = screenshotPairs(report);
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [
      severity,
      issues.filter((issue) => issue.severity === severity).length,
    ]),
  );
  const issueCards = issues.length
    ? issues
        .map(
          (issue, index) => `
          <article class="finding" id="finding-${escapeHtml(issue.issue_id || index + 1)}">
            <div class="finding-index">${String(index + 1).padStart(2, "0")}</div>
            <div>
              <div class="finding-meta"><strong>${escapeHtml(issue.severity)}</strong> / ${escapeHtml(issue.type)} / ${escapeHtml(issue.issue_id)}</div>
              <h3>${escapeHtml(issue.title)}</h3>
              <p>${escapeHtml(issue.detail)}</p>
              ${issue.evidence ? `<details><summary>Inspect evidence</summary><pre>${escapeHtml(JSON.stringify(issue.evidence, null, 2))}</pre></details>` : ""}
            </div>
          </article>`,
        )
        .join("")
    : '<p class="empty">No findings. Coverage must still be complete for this to count as a pass.</p>';
  const contactSheets = pairs.length
    ? `<section aria-labelledby="screenshots-title">
        <div class="section-kicker">02 / CONTACT SHEETS</div>
        <h2 id="screenshots-title">What changed after each action</h2>
        <div class="contact-grid">${pairs
          .map(
            (pair) => `<figure>
              <figcaption>${escapeHtml(pair.label)}</figcaption>
              <div class="pair">
                <a href="${pair.before}"><img src="${pair.before}" alt="Before ${escapeHtml(pair.label)}"><span>Before</span></a>
                <a href="${pair.after}"><img src="${pair.after}" alt="After ${escapeHtml(pair.label)}"><span>After</span></a>
              </div>
            </figure>`,
          )
          .join("")}</div>
      </section>`
    : "";
  const viewports =
    (report.coverage?.viewports_covered || []).join(", ") || "none";
  const duration = Math.round((report.duration_ms || 0) / 1000);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visual QA — ${escapeHtml(report.verdict)} inspection</title>
  <style>
    :root { color-scheme: light; --paper:#f2efe7; --ink:#181816; --muted:#69665f; --line:#c9c3b7; --accent:#b53621; --panel:#fffdf7; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font-family:"Arial Narrow","Aptos Narrow",system-ui,sans-serif; line-height:1.5; }
    a { color:inherit; text-decoration-thickness:2px; text-decoration-color:var(--accent); text-underline-offset:3px; }
    .shell { width:min(1180px, calc(100% - 32px)); margin:0 auto; }
    header { border-top:8px solid var(--accent); border-bottom:1px solid var(--ink); padding:42px 0 34px; }
    .masthead { display:grid; grid-template-columns:minmax(180px,.65fr) minmax(0,2fr); gap:clamp(28px,7vw,100px); align-items:end; }
    .mark,.section-kicker,.finding-meta,.finding-index,dt,footer { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; text-transform:uppercase; }
    .mark { font-size:.77rem; font-weight:700; }
    .mark::before { content:""; display:block; width:34px; height:34px; border:7px solid var(--ink); border-right-color:var(--accent); margin-bottom:18px; }
    h1 { max-width:760px; margin:0; font-size:clamp(3.1rem,9vw,7.8rem); line-height:.82; letter-spacing:-.065em; text-transform:uppercase; }
    .verdict-row { display:grid; grid-template-columns:minmax(0,2fr) minmax(190px,.65fr); gap:28px; margin-top:34px; align-items:end; }
    .verdict-copy { max-width:620px; margin:0; font-size:clamp(1.1rem,2.2vw,1.55rem); }
    .stamp { border:2px solid var(--accent); color:var(--accent); padding:12px 16px 10px; font:800 clamp(1.15rem,3vw,2rem)/1 ui-monospace,SFMono-Regular,Consolas,monospace; text-align:center; transform:rotate(-1deg); }
    main section { padding:54px 0; border-bottom:1px solid var(--ink); }
    .section-kicker { color:var(--accent); font-size:.72rem; font-weight:800; margin-bottom:14px; }
    h2 { max-width:780px; margin:0 0 30px; font-size:clamp(2rem,5vw,4.5rem); line-height:.94; letter-spacing:-.045em; text-transform:uppercase; }
    .metrics { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid var(--ink); background:var(--panel); }
    .metric { min-height:118px; padding:18px; border-right:1px solid var(--line); }
    .metric:last-child { border-right:0; }
    dt { color:var(--muted); font-size:.68rem; }
    dd { margin:14px 0 0; font-size:clamp(1.3rem,3vw,2.4rem); font-weight:800; line-height:1; overflow-wrap:anywhere; }
    .severity-strip { display:flex; flex-wrap:wrap; gap:10px 20px; margin:22px 0 0; padding:0; list-style:none; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.78rem; text-transform:uppercase; }
    .severity-strip strong { color:var(--accent); }
    .finding { display:grid; grid-template-columns:76px minmax(0,1fr); gap:22px; padding:28px 0; border-top:1px solid var(--line); }
    .finding:first-of-type { border-top:2px solid var(--ink); }
    .finding-index { color:var(--accent); font-size:1.45rem; }
    .finding-meta { color:var(--muted); font-size:.68rem; overflow-wrap:anywhere; }
    .finding-meta strong { color:var(--accent); }
    .finding h3 { margin:7px 0 8px; font-size:clamp(1.35rem,3vw,2rem); line-height:1.08; }
    .finding p { max-width:760px; margin:0; font-size:1.03rem; }
    details { margin-top:14px; }
    summary { cursor:pointer; font-weight:800; text-decoration:underline; text-decoration-color:var(--accent); text-underline-offset:3px; }
    pre { max-width:100%; overflow:auto; padding:16px; background:var(--ink); color:var(--paper); font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; }
    .contact-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:34px 20px; }
    figure { margin:0; }
    figcaption { min-height:3em; margin-bottom:10px; font-weight:800; }
    .pair { display:grid; grid-template-columns:1fr 1fr; border:1px solid var(--ink); background:var(--panel); }
    .pair a { position:relative; display:block; border-right:1px solid var(--ink); text-decoration:none; }
    .pair a:last-child { border-right:0; }
    .pair img { display:block; width:100%; aspect-ratio:4/3; object-fit:cover; object-position:top; }
    .pair span { position:absolute; left:0; bottom:0; padding:5px 8px; background:var(--ink); color:var(--paper); font:700 .65rem ui-monospace,SFMono-Regular,Consolas,monospace; text-transform:uppercase; }
    .empty { max-width:680px; font-size:1.2rem; }
    footer { display:flex; justify-content:space-between; gap:20px; padding:24px 0 38px; color:var(--muted); font-size:.68rem; }
    @media (max-width:700px) {
      .shell { width:min(100% - 20px,1180px); }
      header { padding-top:26px; }
      .masthead,.verdict-row { grid-template-columns:1fr; }
      .mark { display:flex; align-items:center; gap:12px; }
      .mark::before { width:24px; height:24px; border-width:5px; margin:0; flex:none; }
      h1 { font-size:clamp(2.8rem,17vw,5rem); }
      .stamp { justify-self:start; }
      main section { padding:38px 0; }
      .metrics { grid-template-columns:1fr 1fr; }
      .metric { min-height:96px; border-bottom:1px solid var(--line); }
      .metric:nth-child(2) { border-right:0; }
      .metric:nth-child(n+3) { border-bottom:0; }
      .finding { grid-template-columns:44px minmax(0,1fr); gap:10px; }
      .contact-grid { grid-template-columns:1fr; }
      footer { flex-direction:column; }
    }
    @media print { body { background:white; } .shell { width:100%; } details:not([open]) > *:not(summary) { display:block; } }
  </style>
</head>
<body>
  <header>
    <div class="shell">
      <div class="masthead">
        <div class="mark">Visual QA<br>Inspection docket</div>
        <h1>Evidence before confidence.</h1>
      </div>
      <div class="verdict-row">
        <p class="verdict-copy">${escapeHtml(verdictMessage(report))}</p>
        <div class="stamp" aria-label="Verdict ${escapeHtml(report.verdict)}">${escapeHtml(report.verdict)}</div>
      </div>
    </div>
  </header>
  <main class="shell">
    <section aria-labelledby="run-title">
      <div class="section-kicker">00 / RUN RECEIPT</div>
      <h2 id="run-title">The bounded walk, at a glance</h2>
      <dl class="metrics">
        <div class="metric"><dt>States</dt><dd>${report.coverage?.states ?? 0}</dd></div>
        <div class="metric"><dt>Actions</dt><dd>${report.coverage?.actions ?? 0}</dd></div>
        <div class="metric"><dt>Duration</dt><dd>${duration}s</dd></div>
        <div class="metric"><dt>Viewports</dt><dd>${escapeHtml(viewports)}</dd></div>
      </dl>
      <ul class="severity-strip" aria-label="Finding counts by severity">
        ${SEVERITIES.map((severity) => `<li>${severity} <strong>${counts[severity]}</strong></li>`).join("")}
      </ul>
      ${report.coverage?.limit_reason ? `<p><strong>Coverage limit:</strong> <code>${escapeHtml(report.coverage.limit_reason)}</code></p>` : ""}
    </section>
    <section aria-labelledby="findings-title">
      <div class="section-kicker">01 / FINDINGS</div>
      <h2 id="findings-title">Fix the sharpest edges first</h2>
      ${issueCards}
    </section>
    ${contactSheets}
  </main>
  <footer class="shell">
    <span>Built by Paul Schwarz / visual-qa</span>
    <span><a href="./report.json">Machine report</a> / <a href="./report.md">Markdown report</a></span>
  </footer>
</body>
</html>`;
}

/** Write the complete, redacted report artifact set promised by the CLI. */
export async function writeReportArtifacts(outDir, report) {
  const safeReport = redact(report);
  await Promise.all([
    writeFile(
      join(outDir, "report.json"),
      `${JSON.stringify(safeReport, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(outDir, "report.md"),
      `${renderMarkdownReport(safeReport)}\n`,
      {
        mode: 0o600,
      },
    ),
    writeFile(
      join(outDir, "report.html"),
      `${renderHtmlReport(safeReport)}\n`,
      {
        mode: 0o600,
      },
    ),
  ]);
  return report;
}
