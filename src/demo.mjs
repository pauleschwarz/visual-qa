// Visual QA - zero-setup demo: bundled defect fixture + one bounded run.
//
// The demo exists so a first-time user (or agent) sees a full report in
// under a minute without writing anything: it serves the seeded-defect
// page, explores it with small bounds, and returns the report.

import { createServer } from "node:http";
import { explore } from "./explore.mjs";
import { DEMO_HTML } from "./demo-html.mjs";

const DEMO_BOUNDS = {
  max_states: 24,
  max_depth: 3,
  max_actions_per_state: 14,
  max_total_actions: 80,
  max_runtime_ms: 240_000,
};

/**
 * Serve the demo fixture on a random localhost port and explore it.
 * Defaults to the mobile viewport: it is the defect-richest view and keeps
 * the first run a complete bounded walk, not a coverage warning.
 * `overrides` exist for tests; everything defaults to a fast bounded walk.
 */
export async function demo({
  outDir = ".qa-demo",
  bounds = {},
  viewports = [{ name: "mobile", width: 390, height: 844 }],
} = {}) {
  const server = createServer((req, res) => {
    if (req.url === "/api/fail") {
      res.writeHead(500);
      return res.end("fixture failure");
    }
    if (req.url === "/missing") {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(DEMO_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await explore({
      baseUrl: `http://127.0.0.1:${port}/`,
      outDir,
      bounds: { ...DEMO_BOUNDS, ...bounds },
      viewports,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
