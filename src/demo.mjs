// Visual QA - zero-setup demo: bundled defect fixture + one bounded run.
//
// First-run contract: complete the seeded fixture as FAIL (not
// COVERAGE_INCOMPLETE) in under two minutes on typical hardware.

import { createServer } from "node:http";
import { explore } from "./explore.mjs";
import { DEMO_HTML } from "./demo-html.mjs";

// Sized to the fixture graph: enough room to hit seeded defects, small
// enough that wall-clock stays under ~90s with the walker defaults.
const DEMO_BOUNDS = {
  max_states: 16,
  max_depth: 4,
  max_actions_per_state: 14,
  max_total_actions: 80,
  max_runtime_ms: 120_000,
};

/**
 * Serve the demo fixture on a random localhost port and explore it.
 * Defaults to mobile: defect-richest viewport. Expect verdict FAIL with
 * seeded findings when the walk completes inside the budget.
 * `overrides` exist for tests.
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
