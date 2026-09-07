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

/** One-line locator for humans — not buried in collapsed JSON. */
export function findingWhere(evidence = {}) {
  if (!evidence || typeof evidence !== "object") return "";
  if (typeof evidence.selector === "string" && evidence.selector.trim())
    return evidence.selector.trim();
  const nodeTarget = evidence.nodes?.[0]?.target;
  if (Array.isArray(nodeTarget) && nodeTarget.length)
    return nodeTarget.flat().filter(Boolean).join(" ");
  if (typeof nodeTarget === "string" && nodeTarget.trim()) return nodeTarget.trim();
  const control = evidence.control;
  if (control && typeof control === "object") {
    const role = control.role || control.tag || "control";
    const name = control.name || control.testId || control.id || "";
    const box = control.box
      ? ` @(${control.box.x},${control.box.y} ${control.box.w}x${control.box.h})`
      : "";
    return name ? `${role} "${name}"${box}` : `${role}${box}`;
  }
  if (typeof evidence.url === "string" && evidence.url.trim())
    return evidence.url.trim();
  if (typeof evidence.rule === "string" && evidence.rule.trim())
    return `rule:${evidence.rule.trim()}`;
  return "";
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
        .map((issue, index) => {
          const where = findingWhere(issue.evidence);
          return `
          <article class="finding" id="finding-${escapeHtml(issue.issue_id || index + 1)}">
            <div class="finding-index">${String(index + 1).padStart(2, "0")}</div>
            <div>
              <div class="finding-meta"><strong>${escapeHtml(issue.severity)}</strong> / ${escapeHtml(issue.type)} / ${escapeHtml(issue.issue_id)}</div>
              <h3>${escapeHtml(issue.title)}</h3>
              <p>${escapeHtml(issue.detail)}</p>
              ${where ? `<p class="finding-where"><span>Where</span> ${escapeHtml(where)}</p>` : ""}
              ${issue.evidence ? `<details><summary>Inspect evidence</summary><pre>${escapeHtml(JSON.stringify(issue.evidence, null, 2))}</pre></details>` : ""}
            </div>
          </article>`;
        })
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
    :root {
      color-scheme: light;
      --paper:#f7f4ee;
      --ink:#171717;
      --muted:#5f5a52;
      --line:#d8d2c6;
      --accent:#9b2c1f;
      --panel:#fffdf8;
      --ok:#1f6b4a;
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:var(--paper);
      color:var(--ink);
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
      line-height:1.55;
      -webkit-font-smoothing: antialiased;
    }
    a { color:inherit; text-decoration-thickness:1.5px; text-decoration-color:color-mix(in srgb, var(--accent) 70%, transparent); text-underline-offset:3px; }
    a:hover { text-decoration-color:var(--accent); }
    .shell { width:min(1080px, calc(100% - 40px)); margin:0 auto; }
    header { border-top:6px solid var(--accent); border-bottom:1px solid var(--line); padding:36px 0 28px; }
    .masthead { display:grid; grid-template-columns:minmax(140px,.5fr) minmax(0,2.2fr); gap:clamp(24px,5vw,72px); align-items:end; }
    .mark,.section-kicker,.finding-meta,.finding-index,dt,footer,.severity-strip { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing:.06em; text-transform:uppercase; }
    .mark { font-size:.72rem; font-weight:600; color:var(--muted); }
    .mark::before { content:""; display:block; width:28px; height:28px; border:6px solid var(--ink); border-right-color:var(--accent); margin-bottom:14px; }
    h1 {
      max-width:18ch;
      margin:0;
      font-family: "Avenir Next", "Segoe UI", system-ui, sans-serif;
      font-size:clamp(2.4rem,6.5vw,4.6rem);
      line-height:.95;
      letter-spacing:-.04em;
      font-weight:700;
      text-transform:none;
    }
    .verdict-row { display:grid; grid-template-columns:minmax(0,2fr) minmax(180px,.55fr); gap:24px; margin-top:28px; align-items:end; }
    .verdict-copy { max-width:54ch; margin:0; font-size:clamp(1.05rem,1.8vw,1.25rem); color:var(--muted); }
    .stamp {
      border:1.5px solid var(--accent);
      color:var(--accent);
      background: color-mix(in srgb, var(--panel) 88%, white);
      padding:10px 14px 9px;
      font:700 clamp(1rem,2.4vw,1.45rem)/1 "Avenir Next","Segoe UI",system-ui,sans-serif;
      letter-spacing:.02em;
      text-align:center;
      justify-self:end;
    }
    .stamp[data-verdict="PASS"] { border-color:var(--ok); color:var(--ok); }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--line); background:var(--panel); margin-top:28px; }
    .metric { min-height:108px; padding:18px 16px 16px; border-right:1px solid var(--line); }
    .metric:last-child { border-right:0; }
    .metric dt { margin:0 0 10px; color:var(--muted); font-size:.66rem; }
    .metric dd { margin:0; font:700 clamp(1.55rem,3vw,2.1rem)/1 "Avenir Next","Segoe UI",system-ui,sans-serif; letter-spacing:-.03em; overflow-wrap:anywhere; }
    .severity-strip { display:flex; flex-wrap:wrap; gap:10px 18px; margin:18px 0 0; padding:0; list-style:none; font-size:.72rem; color:var(--muted); }
    .severity-strip strong { color:var(--accent); font-weight:700; }
    main section { padding:42px 0; border-bottom:1px solid var(--line); }
    .section-kicker { color:var(--muted); font-size:.68rem; margin-bottom:10px; }
    h2 {
      margin:0 0 18px;
      font-family: "Avenir Next","Segoe UI",system-ui,sans-serif;
      font-size:clamp(1.35rem,2.6vw,1.85rem);
      letter-spacing:-.02em;
      font-weight:700;
    }
    .finding { display:grid; grid-template-columns:64px minmax(0,1fr); gap:18px; padding:22px 0; border-top:1px solid var(--line); }
    .finding:first-of-type { border-top:1.5px solid var(--ink); }
    .finding-index { color:var(--accent); font-size:1.15rem; padding-top:4px; }
    .finding-meta { color:var(--muted); font-size:.64rem; overflow-wrap:anywhere; }
    .finding-meta strong { color:var(--accent); font-weight:700; }
    .finding h3 {
      margin:6px 0 8px;
      font-family: "Avenir Next","Segoe UI",system-ui,sans-serif;
      font-size:clamp(1.15rem,2.2vw,1.45rem);
      line-height:1.2;
      letter-spacing:-.02em;
      font-weight:700;
    }
    .finding p { max-width:68ch; margin:0; font-size:1.02rem; color:var(--ink); }
    .finding-where { margin-top:10px !important; color:var(--muted); font-size:.95rem !important; }
    .finding-where span {
      font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      letter-spacing:.06em;
      text-transform:uppercase;
      font-size:.64rem;
      color:var(--accent);
      margin-right:8px;
    }
    details { margin-top:12px; }
    summary {
      cursor:pointer;
      font-family: "Avenir Next","Segoe UI",system-ui,sans-serif;
      font-weight:650;
      font-size:.95rem;
      text-decoration:underline;
      text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent);
      text-underline-offset:3px;
    }
    pre {
      max-width:100%;
      overflow:auto;
      padding:14px 16px;
      background:var(--ink);
      color:var(--paper);
      border-radius:2px;
      font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    }
    .contact-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:28px 18px; }
    figure { margin:0; }
    figcaption {
      min-height:2.6em;
      margin-bottom:8px;
      font-family: "Avenir Next","Segoe UI",system-ui,sans-serif;
      font-weight:650;
      font-size:.95rem;
    }
    .pair { display:grid; grid-template-columns:1fr 1fr; border:1px solid var(--line); background:var(--panel); }
    .pair a { position:relative; display:block; border-right:1px solid var(--line); text-decoration:none; }
    .pair a:last-child { border-right:0; }
    .pair img { display:block; width:100%; aspect-ratio:4/3; object-fit:cover; object-position:top; background:#ece7dc; }
    .pair span {
      position:absolute; left:0; bottom:0; padding:4px 7px;
      background: color-mix(in srgb, var(--ink) 88%, transparent);
      color:var(--paper);
      font:650 .62rem ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      text-transform:uppercase; letter-spacing:.05em;
    }
    .empty { max-width:58ch; font-size:1.15rem; color:var(--muted); }
    footer {
      display:flex; justify-content:space-between; gap:20px;
      padding:22px 0 34px; color:var(--muted); font-size:.64rem;
    }
    @media (max-width:700px) {
      .shell { width:min(100% - 24px,1080px); }
      header { padding-top:24px; }
      .masthead,.verdict-row { grid-template-columns:1fr; }
      .mark { display:flex; align-items:center; gap:12px; }
      .mark::before { width:22px; height:22px; border-width:5px; margin:0; flex:none; }
      h1 { font-size:clamp(2.1rem,12vw,3.4rem); max-width:none; }
      .stamp { justify-self:start; }
      main section { padding:32px 0; }
      .metrics { grid-template-columns:1fr 1fr; }
      .metric { min-height:92px; border-bottom:1px solid var(--line); }
      .metric:nth-child(2) { border-right:0; }
      .metric:nth-child(n+3) { border-bottom:0; }
      .finding { grid-template-columns:40px minmax(0,1fr); gap:10px; }
      .contact-grid { grid-template-columns:1fr; }
      .pair { grid-template-columns:1fr; }
      .pair a { border-right:0; border-bottom:1px solid var(--line); }
      .pair a:last-child { border-bottom:0; }
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
        <div class="stamp" data-verdict="${escapeHtml(report.verdict)}" aria-label="Verdict ${escapeHtml(report.verdict)}">${escapeHtml(report.verdict)}</div>
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
