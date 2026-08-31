import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyFixes,
  collectFixes,
  contrastRatio,
  findSelectorInHtml,
  fixedForeground,
  parseContrastSummary,
} from "../src/fix.mjs";

test("contrastRatio matches WCAG reference values", () => {
  // White on black is the maximum ratio 21:1; identical colors are 1:1.
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  assert.ok(Math.abs(contrastRatio(white, black) - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio(white, white) - 1) < 0.01);
  // #767676 on #ffffff is the classic 4.54:1 minimum-contrast gray.
  assert.ok(Math.abs(contrastRatio([118, 118, 118], white) - 4.54) < 0.02);
});

test("fixedForeground reaches the target ratio with a minimal blend", () => {
  const bg = [255, 255, 255];
  const fg = [224, 224, 224]; // fails 4.5:1 on white
  const fixed = fixedForeground(fg, bg, 4.5);
  assert.ok(fixed, "a reachable fix exists");
  assert.ok(contrastRatio(fixed, bg) >= 4.5);
  // The fix must be closer to the original than a full flip to black.
  assert.ok(Math.abs(fixed[0] - fg[0]) < 255);
  // Dark background: lightening must be reachable as well.
  const fixedDark = fixedForeground([20, 20, 20], [10, 10, 10], 4.5);
  assert.ok(fixedDark);
  assert.ok(contrastRatio(fixedDark, [10, 10, 10]) >= 4.5);
  // Unreachable target reports null instead of returning a lie.
  assert.equal(fixedForeground([128, 128, 128], [128, 128, 128], 21), null);
});

test("parseContrastSummary extracts colors, size, and weight from axe output", () => {
  const summary =
    "Element has insufficient color contrast of 1.07 (foreground color: #ffffff, background color: #fefefe, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1";
  const parsed = parseContrastSummary(summary);
  assert.deepEqual(parsed.fg, [255, 255, 255]);
  assert.deepEqual(parsed.bg, [254, 254, 254]);
  assert.equal(parsed.fontSizePx, 16);
  assert.equal(parsed.bold, false);
  assert.equal(parseContrastSummary("no colors here"), null);
});

test("findSelectorInHtml supports the simple selector subset only", () => {
  const html =
    '<body><p id="notice" class="warn box">a</p><span class="faint">b</span></body>';
  assert.equal(findSelectorInHtml(html, "#notice").status, "found");
  assert.equal(findSelectorInHtml(html, ".faint").status, "found");
  assert.equal(findSelectorInHtml(html, "span.faint").status, "found");
  assert.equal(findSelectorInHtml(html, "p.warn.box").status, "found");
  assert.equal(findSelectorInHtml(html, "#missing").status, "missing");
  // Combinators and attribute selectors must be refused, not guessed.
  assert.equal(findSelectorInHtml(html, "body > p").status, "unsupported");
  assert.equal(
    findSelectorInHtml(html, '[data-x="1"]').status,
    "unsupported",
  );
});

test("contrast fixes travel with their axe nodes through collectFixes", () => {
  const issues = [
    {
      evidence: {
        rule: "color-contrast",
        nodes: [
          {
            target: ["#notice"],
            failureSummary: "foreground color: #ffffff, background color: #ffffff, font size: 12.0pt (16px), font weight: normal",
          },
        ],
      },
    },
    { evidence: { rule: "document-title" } },
  ];
  const fixes = collectFixes(issues);
  assert.deepEqual(fixes.map((f) => f.kind).sort(), ["contrast", "title"]);
  assert.equal(fixes.find((f) => f.kind === "contrast").nodes.length, 1);
});

test("applyFixes corrects failing contrast and reports unsupported targets", async () => {
  const dir = await mkdtemp(`${tmpdir()}/vqa-contrast-`);
  const file = join(dir, "index.html");
  await writeFile(
    file,
    '<html lang="en"><head><title>App</title></head><body><p id="notice" style="color:#ffffff">Wichtig</p><span data-x="1" style="color:#f5f5f5">faint</span></body></html>',
  );
  const summary =
    "Element has insufficient color contrast of 1.00 (foreground color: #ffffff, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1";
  const { applied, skipped } = await applyFixes(
    [
      {
        kind: "contrast",
        nodes: [
          { selector: "#notice", summary },
          { selector: "[data-x=\"1\"]", summary },
        ],
      },
    ],
    dir,
  );
  // The simple selector is patched to a verified-ratio color.
  const contrastEntry = applied.find((entry) => entry.kind === "contrast");
  assert.ok(contrastEntry, "contrast fix applied");
  const html = await readFile(file, "utf8");
  const patchedColor = /id="notice"[^>]*color:rgb\((\d+), (\d+), (\d+)\)"/.exec(
    html,
  );
  assert.ok(patchedColor, "inline color patched");
  const rgb = patchedColor.slice(1, 4).map(Number);
  assert.ok(contrastRatio(rgb, [255, 255, 255]) >= 4.5);
  // The attribute selector is refused honestly, with its reason.
  const unsupported = skipped.find((entry) => entry.reason === "selector_unsupported");
  assert.ok(unsupported);
});
