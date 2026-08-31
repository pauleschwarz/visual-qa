// Visual QA - CI output: JUnit XML for pipeline integrations.
//
// One testcase per issue; critical/high findings become failures so the
// pipeline marks the step red, medium/low stay as system-out notes.
// COVERAGE_INCOMPLETE is always a failure: no pipeline should be able to
// confuse an unexplored run with a passing one.

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderJunitXml(report) {
  const issues = report.issues || [];
  const cases = issues.map((issue) => {
    const failing = ["critical", "high"].includes(issue.severity);
    return {
      id: issue.issue_id,
      type: issue.type,
      severity: issue.severity,
      title: issue.title,
      failing,
      detail: `${issue.title}: ${issue.detail}`,
    };
  });
  if (report.verdict === "COVERAGE_INCOMPLETE") {
    cases.push({
      id: "vqa-coverage-incomplete",
      type: "vqa-coverage",
      severity: "high",
      title: "Coverage incomplete",
      failing: true,
      detail: `Exploration did not complete: ${report.coverage?.limit_reason || "unknown limit"}. A pipeline must not read this as a pass.`,
    });
  }
  const failures = cases.filter((c) => c.failing).length;
  const name = `visual-qa ${report.run_id || ""}`.trim();
  const body = cases
    .map((c) =>
      [
        `    <testcase classname="${escapeXml(c.type)}" name="${escapeXml(c.id)}">`,
        c.failing
          ? `      <failure message="${escapeXml(c.title)}">${escapeXml(c.detail)}</failure>`
          : `      <system-out>${escapeXml(c.detail)}</system-out>`,
        `    </testcase>`,
      ].join("\n"),
    )
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `  <testsuite name="${escapeXml(name)}" tests="${cases.length}" failures="${failures}">`,
    body,
    `  </testsuite>`,
    `</testsuites>`,
    ``,
  ].join("\n");
}
