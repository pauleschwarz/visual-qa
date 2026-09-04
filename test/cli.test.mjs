import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "visual-qa.mjs");

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("help is successful and printed to stdout", () => {
  for (const args of [["--help"], ["help"], ["demo", "--help"]]) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, "");
  }
});

test("missing option values and invalid URLs block before browser work", () => {
  const missing = cli("explore", "--url");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--url requires a value/);

  const invalid = cli("explore", "--url", "not-a-url");
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Invalid baseUrl/);
});

test("invalid bounds and unsafe destructive mode are actionable", () => {
  const invalidBound = cli(
    "explore",
    "--url",
    "http://127.0.0.1:1",
    "--max-states",
    "many",
  );
  assert.equal(invalidBound.status, 2);
  assert.match(invalidBound.stderr, /max_states must be an integer/);

  const unsafe = cli(
    "run",
    "--url",
    "http://127.0.0.1:1",
    "--allow-destructive",
  );
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /requires --isolated/);
});

test("unsupported option combinations block instead of being ignored", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "vqa-cli-options-"));
  const ignoredFix = cli(
    "explore",
    "--url",
    "http://127.0.0.1:1",
    "--intent",
    "change it",
  );
  assert.equal(ignoredFix.status, 2);
  assert.match(ignoredFix.stderr, /require the run command/);

  const wrongOutput = cli(
    "explore",
    "--mode",
    "off",
    "--out-file",
    join(outDir, "result.xml"),
  );
  assert.equal(wrongOutput.status, 2);
  assert.match(wrongOutput.stderr, /requires --format junit/);

  const unwritableOutput = cli(
    "explore",
    "--mode",
    "off",
    "--format",
    "junit",
    "--out-file",
    outDir,
  );
  assert.equal(unwritableOutput.status, 2);
  assert.match(unwritableOutput.stderr, /Could not write JUnit report/);
});

test("a total browser startup failure uses blocked exit code 2", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "vqa-cli-blocked-"));
  const result = cli(
    "explore",
    "--url",
    "http://127.0.0.1:1",
    "--out",
    outDir,
    "--max-states",
    "1",
    "--max-actions",
    "1",
    "--max-runtime-ms",
    "1000",
  );
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Visual QA BLOCKED/);
  assert.match(result.stdout, /report\.html/);
});
