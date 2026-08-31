// Visual QA - human-readable report aggregation.
//
// report.json is the machine contract; report.md is the summary a human or an
// orchestrator reads first. It renders the final merged report, so phases
// (vision, fix/verify) appear here, not in the raw explore output.

const SEVERITIES = ["critical", "high", "medium", "low"];

/**
 * The machine summary agents consume: verdict, counts, the top findings,
 * and where the full evidence lives. Deliberately small - an agent wants
 * the next actions, not the whole report.
 */
export function summarizeReport(report) {
  const issues = report.issues || [];
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
  if (summary.limit_reason) lines.push(`coverage limit: ${summary.limit_reason}`);
  for (const [phase, info] of Object.entries(summary.phases || {}))
    lines.push(`  ${phase}: ${JSON.stringify(info)}`);
  for (const issue of summary.issues)
    lines.push(`${issue.severity.toUpperCase()} ${issue.id}: ${issue.title}`);
  return lines;
}

function truncate(text, max = 160) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push(`# Visual QA Report`);
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

  const issues = report.issues || [];
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
    lines.push("| Type | Title | Detail |");
    lines.push("| --- | --- | --- |");
    for (const issue of group) {
      lines.push(
        `| \`${issue.type}\` | ${truncate(issue.title, 90)} | ${truncate(issue.detail, 140)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
