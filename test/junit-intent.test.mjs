import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dryRunIntent, parseIntent } from "../src/intent.mjs";
import { renderJunitXml } from "../src/junit.mjs";

test("junit xml turns critical/high findings into failures", () => {
  const xml = renderJunitXml({
    run_id: "abc12345",
    verdict: "FAIL",
    coverage: { limit_reason: null },
    issues: [
      {
        issue_id: "vqa-runtime-unhandled-page-error",
        type: "vqa-runtime",
        severity: "critical",
        title: "Unhandled page error",
        detail: 'boom <tag> & "stuff"',
      },
      {
        issue_id: "vqa-slop-meta-description-missing",
        type: "vqa-slop",
        severity: "low",
        title: "Meta description missing",
        detail: "no meta",
      },
    ],
  });
  assert.match(xml, /<testsuite name="visual-qa abc12345" tests="2" failures="1">/);
  assert.match(xml, /<failure message="Unhandled page error">/);
  // XML-escaping must survive quotes and angle brackets.
  assert.match(xml, /boom &lt;tag&gt; &amp; &quot;stuff&quot;/);
  // Low severity is a note, not a failure.
  const lowCase = xml.split("<testcase")[2];
  assert.match(lowCase, /<system-out>/);
  assert.doesNotMatch(lowCase, /<failure/);
});

test("junit xml marks incomplete coverage as a failure", () => {
  const xml = renderJunitXml({
    verdict: "COVERAGE_INCOMPLETE",
    coverage: { limit_reason: "max_runtime_ms" },
    issues: [],
  });
  assert.match(xml, /<failure message="Coverage incomplete">/);
  assert.match(xml, /max_runtime_ms/);
});

test("intent dry-run validates catalog targets without a browser", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-dry-`);
  await writeFile(
    join(dir, "index.html"),
    '<html><body><button id="buy">Add item</button><h2>Title</h2></body></html>',
  );
  const hit = await dryRunIntent(
    parseIntent('ändere die Farbe von "Add item" auf grün'),
    dir,
  );
  assert.equal(hit.parsed, true);
  assert.equal(hit.found, true);
  assert.match(hit.file, /index\.html$/);

  const tagHit = await dryRunIntent(
    parseIntent("ändere die Farbe der Überschrift auf blau"),
    dir,
  );
  assert.equal(tagHit.found, true);

  const missing = await dryRunIntent(
    parseIntent('ändere die Farbe von "Kein Treffer" auf rot'),
    dir,
  );
  assert.equal(missing.found, false);
  assert.equal(missing.reason, "target_not_in_sources");

  const unparsed = await dryRunIntent(
    parseIntent("mach alles schöner"),
    dir,
  );
  assert.equal(unparsed.parsed, false);

  const noDir = await dryRunIntent(
    parseIntent('ändere die Farbe von "Add item" auf grün'),
    null,
  );
  assert.equal(noDir.found, false);
  assert.equal(noDir.reason, "no_fix_dir");
});
