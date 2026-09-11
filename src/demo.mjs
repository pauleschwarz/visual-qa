// Visual QA - zero-setup demo: bundled defect fixture + one bounded run.
//
// First-run contract: complete the seeded fixture as FAIL (not
// COVERAGE_INCOMPLETE) in under two minutes on typical hardware.

import { createServer } from "node:http";
import { explore } from "./explore.mjs";
import { DEMO_HTML } from "./demo-html.mjs";

// Sized as fast deterministic smoke coverage. Full visual proof belongs to
// run() with mandatory vision review; demo intentionally never claims it.
const DEMO_BOUNDS = {
  max_states: 4,
  max_depth: 3,
  max_actions_per_state: 8,
  max_total_actions: 20,
  max_runtime_ms: 60_000,
};

/**
 * Serve the demo fixture on a random localhost port and explore it.
 * Defaults to mobile: defect-richest viewport. Expect seeded findings and
 * COVERAGE_INCOMPLETE: demo is smoke coverage, never a ship verdict.
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
