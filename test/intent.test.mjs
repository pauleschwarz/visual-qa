import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyIntent, parseIntent, runIntentChecks } from "../src/intent.mjs";

test("parseIntent understands German and English color instructions", () => {
  const german = parseIntent('ändere die Farbe von "Add item" auf grün');
  assert.equal(german.kind, "color");
  assert.equal(german.property, "color");
  assert.equal(german.value, "grün");
  assert.deepEqual(german.valueRgb, [22, 163, 74]);
  assert.deepEqual(german.target, { text: "Add item" });

  const english = parseIntent('change the color of "Header" to #10b981');
  assert.deepEqual(english.valueRgb, [16, 185, 129]);
  assert.deepEqual(english.target, { text: "Header" });

  const tag = parseIntent("ändere die Farbe des Buttons auf rot");
  assert.deepEqual(tag.target, { tag: "button" });
  assert.equal(tag.value, "rot");

  const background = parseIntent('ändere den Hintergrund von "header" auf #123456');
  assert.equal(background.property, "background-color");

  const rgb = parseIntent("make the text color rgb(10, 20, 30)");
  assert.deepEqual(rgb.valueRgb, [10, 20, 30]);
});

test("parseIntent rejects anything it cannot fully understand", () => {
  assert.equal(parseIntent("mach es schöner"), null);
  assert.equal(parseIntent("ändere die Farbe von X auf petrol"), null);
  assert.equal(parseIntent(""), null);
  assert.equal(parseIntent(null), null);
});

test("applyIntent patches inline style and writes trace copies", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-intent-`);
  const file = join(dir, "index.html");
  await writeFile(
    file,
    '<!doctype html><html lang="en"><head><title>Shop</title></head><body><button id="buy">Add item</button></body></html>',
  );
  const traceDir = join(dir, "trace");
  const intent = parseIntent('ändere die Farbe von "Add item" auf grün');
  const result = await applyIntent(intent, dir, traceDir);
  assert.equal(result.applied, true);
  const html = await readFile(file, "utf8");
  assert.match(html, /<button id="buy" style="color:rgb\(22, 163, 74\)">Add item<\/button>/);
  const traced = await readdir(traceDir);
  assert.ok(traced.includes("index.html.before.html"));
  assert.ok(traced.includes("index.html.after.html"));
});

test("applyIntent merges into an existing style attribute", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-intent-`);
  const file = join(dir, "index.html");
  await writeFile(
    file,
    '<html><body><h1 style="font-weight:700">Titel</h1></body></html>',
  );
  const result = await applyIntent(
    parseIntent("ändere die Farbe der Überschrift auf blau"),
    dir,
  );
  assert.equal(result.applied, true);
  const html = await readFile(file, "utf8");
  assert.match(html, /style="font-weight:700;color:rgb\(37, 99, 235\)"/);
});

test("applyIntent writes resolved rgb, not locale color words", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-intent-`);
  const file = join(dir, "index.html");
  await writeFile(
    file,
    "<html><body><button id=\"buy\">Add item</button></body></html>",
  );
  const result = await applyIntent(
    parseIntent('ändere die Farbe von "Add item" auf grün'),
    dir,
  );
  assert.equal(result.applied, true);
  const html = await readFile(file, "utf8");
  // "grün" is not a CSS value: the patch must carry the resolved rgb().
  assert.match(html, /style="color:rgb\(22, 163, 74\)"/);
  assert.doesNotMatch(html, /color:grün/);
});

test("applyIntent reports a missing target instead of guessing", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-intent-`);
  await writeFile(join(dir, "index.html"), "<html><body><p>hi</p></body></html>");
  const result = await applyIntent(
    parseIntent('ändere die Farbe von "Nicht vorhanden" auf rot'),
    dir,
  );
  assert.equal(result.applied, false);
  assert.equal(result.reason, "no_matching_file");
});

test("runIntentChecks compares computed styles against the intent", async () => {
  const fakePage = {
    evaluate: async (fn, specs) =>
      specs.map((spec) =>
        spec.target.text === "Add item"
          ? { found: true, computed: "rgb(22, 163, 74)", rgb: [22, 163, 74] }
          : { found: true, computed: "rgb(0, 0, 0)", rgb: [0, 0, 0] },
      ),
  };
  const matched = parseIntent('ändere die Farbe von "Add item" auf grün');
  const mismatched = parseIntent('ändere die Farbe von "Other" auf grün');
  const issues = await runIntentChecks(fakePage, [matched, mismatched], {
    viewport: "desktop",
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, "Intent change not applied");
  assert.equal(issues[0].type, "vqa-intent");
});
