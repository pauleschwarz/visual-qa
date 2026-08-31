// Intentional-defect fixture for the Visual QA e2e suite.
// The seeded HTML lives in src/demo-html.mjs so the npm package ships
// exactly what the repo tests against - one source of truth, and the
// fixture server stays import-light (no exploration runtime).
import { DEMO_HTML } from "../src/demo-html.mjs";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 4173);

createServer((req, res) => {
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
}).listen(port, "127.0.0.1", () => console.log(`fixture http://127.0.0.1:${port}`));
