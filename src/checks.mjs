// Visual QA - deterministic checks. Model review can enrich these later, never
// override a hard failure.

import { AxeBuilder } from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { redact } from "./config.mjs";
import { sameOrigin } from "./state.mjs";

function issue(type, title, severity, detail, evidence = {}) {
  return {
    issue_id: `vqa-${type}-${slug(title)}`,
    type: `vqa-${type}`,
    title,
    severity,
    detail,
    evidence: redact(evidence),
  };
}
function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function runA11y(page) {
  try {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const out = result.violations.map((v) =>
      issue("accessibility", v.help, "high", v.description, {
        rule: v.id,
        impact: v.impact,
        nodes: v.nodes
          .slice(0, 10)
          .map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
      }),
    );
    // Critical means critical: contrast nodes axe could not MEASURE are a
    // gap in the evidence, not a pass. They are findings under their own
    // rule name so the autofix whitelist (which needs parsed colors) is not
    // triggered on unverifiable nodes.
    for (const v of result.incomplete ?? []) {
      if (v.id !== "color-contrast") continue;
      out.push(
        issue(
          "accessibility",
          "Contrast could not be verified",
          "medium",
          "axe could not measure color contrast for these nodes; the rendered contrast is unproven",
          {
            rule: "color-contrast-incomplete",
            nodes: v.nodes
              .slice(0, 10)
              .map((n) => ({ target: n.target, html: (n.html || "").slice(0, 160) })),
          },
        ),
      );
    }
    return out;
  } catch (error) {
    return [
      issue(
        "accessibility",
        "Accessibility scan unavailable",
        "medium",
        String(error),
      ),
    ];
  }
}

export async function runLayoutChecks(page, viewport) {
  // A broken evaluate must never look like "zero findings": that silently
  // contributes a false PASS. Mirror runA11y and report the scan itself.
  let findings;
  try {
    findings = await page.evaluate(() => {
      const root = document.documentElement;
      const overflow = root.scrollWidth > root.clientWidth + 1;
      const clipped = [
        ...document.querySelectorAll("button,a,input,select,textarea,[role]"),
      ]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.right > window.innerWidth + 1 ||
            r.left < -1 ||
            r.bottom > document.documentElement.scrollHeight + 1
          );
        })
        .slice(0, 10)
        .map((el) => ({
          tag: el.tagName,
          text: (el.textContent || el.getAttribute("aria-label") || "")
            .trim()
            .slice(0, 80),
        }));
      const smallTargets = [
        ...document.querySelectorAll(
          "button,a,input,select,textarea,[role=button],[role=link]",
        ),
      ]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
        })
        .slice(0, 10)
        .map((el) => ({
          tag: el.tagName,
          text: (el.textContent || el.getAttribute("aria-label") || "")
            .trim()
            .slice(0, 80),
        }));
      const missingNames = [
        ...document.querySelectorAll(
          "button,a,input,select,textarea,[role=button],[role=link]",
        ),
      ]
        .filter(
          (el) =>
            !el.getAttribute("aria-label") &&
            !el.textContent?.trim() &&
            !el.getAttribute("placeholder") &&
            !el.labels?.length,
        )
        .slice(0, 10)
        .map((el) => el.outerHTML.slice(0, 160));
      return { overflow, clipped, smallTargets, missingNames };
    });
  } catch (error) {
    return [
      issue(
        "visual",
        "Layout checks unavailable",
        "medium",
        "Layout probe failed; a page crash here would otherwise count as a clean run",
        { viewport, error: String(error) },
      ),
    ];
  }
  const out = [];
  if (findings.overflow)
    out.push(
      issue(
        "visual",
        "Horizontal overflow",
        "high",
        "Document exceeds viewport width",
        { viewport, ...findings },
      ),
    );
  if (findings.clipped.length)
    out.push(
      issue(
        "visual",
        "Interactive content clipped",
        "high",
        "Interactive content is outside the viewport",
        { viewport, items: findings.clipped },
      ),
    );
  if (findings.smallTargets.length)
    out.push(
      issue(
        "accessibility",
        "Touch targets below 24px",
        "medium",
        "Interactive targets are hard to operate",
        { viewport, items: findings.smallTargets },
      ),
    );
  if (findings.missingNames.length)
    out.push(
      issue(
        "accessibility",
        "Interactive control has no accessible name",
        "high",
        "Control cannot be identified by assistive technology",
        { viewport, items: findings.missingNames },
      ),
    );
  return out;
}

/**
 * Scrollable pages hide defects between the positions a click ever reaches:
 * a viewport with no readable content, or fixed chrome overlapping itself.
 * Sampled deterministically over the whole runway, not just at load.
 */
export async function runScrollChecks(page, viewport, { samples = 12 } = {}) {
  // Same contract as runLayoutChecks: a failed probe is a finding, not silence.
  let findings;
  try {
    findings = await page.evaluate(async (steps) => {
      const root = document.documentElement;
      const max = Math.max(0, root.scrollHeight - window.innerHeight);
      const start = window.scrollY;
      const fixed = [...document.querySelectorAll("body *")]
        .filter((el) => getComputedStyle(el).position === "fixed")
        .filter((el) => el.getAttribute("aria-hidden") !== "true")
        .filter((el) => getComputedStyle(el).pointerEvents !== "none")
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        })
        .slice(0, 12);
      const overlaps = [];
      for (let i = 0; i < fixed.length; i++)
        for (let j = i + 1; j < fixed.length; j++) {
          if (fixed[i].contains(fixed[j]) || fixed[j].contains(fixed[i]))
            continue;
          const a = fixed[i].getBoundingClientRect();
          const b = fixed[j].getBoundingClientRect();
          if (
            a.right > b.left &&
            b.right > a.left &&
            a.bottom > b.top &&
            b.bottom > a.top
          )
            overlaps.push({
              a: fixed[i].id || fixed[i].className || fixed[i].tagName,
              b: fixed[j].id || fixed[j].className || fixed[j].tagName,
            });
        }
      const blank = [];
      const step = max / Math.max(1, steps);
      for (let n = 0; n <= steps; n++) {
        const y = Math.round(n * step);
        window.scrollTo(0, y);
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        let chars = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.nodeValue?.trim();
          if (!text) continue;
          const el = node.parentElement;
          if (!el) continue;
          const s = getComputedStyle(el);
          if (s.visibility === "hidden" || s.display === "none") continue;
          // Near-transparent content is not readable content. Scroll-driven
          // fades otherwise keep an empty viewport looking populated.
          let opacity = 1;
          let chrome = false;
          for (
            let n = el;
            n && n !== document.documentElement;
            n = n.parentElement
          ) {
            const cs = getComputedStyle(n);
            opacity *= Number(cs.opacity);
            if (cs.position === "fixed" || cs.position === "sticky")
              chrome = true;
          }
          // Fixed/sticky chrome (nav, status line) is present at every scroll
          // position, so counting it hides genuinely empty runway sections.
          if (chrome || opacity < 0.15) continue;
          const r = el.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
          if (r.right <= 0 || r.left >= window.innerWidth) continue;
          chars += text.length;
        }
        if (chars < 40) blank.push({ scrollY: y, chars });
      }
      window.scrollTo(0, start);
      return {
        blank: blank.slice(0, 10),
        overlaps: overlaps.slice(0, 10),
        max,
      };
    }, samples);
  } catch (error) {
    return [
      issue(
        "visual",
        "Scroll checks unavailable",
        "medium",
        "Scroll probe failed; hidden viewport defects would otherwise go unmeasured",
        { viewport, error: String(error) },
      ),
    ];
  }
  const out = [];
  if (findings.max > 0 && findings.blank.length)
    out.push(
      issue(
        "visual",
        "Scroll position shows no readable content",
        "high",
        "A user scrolling through the page reaches an effectively empty viewport",
        { viewport, items: findings.blank, scrollable: findings.max },
      ),
    );
  if (findings.overlaps.length)
    out.push(
      issue(
        "visual",
        "Fixed chrome overlaps",
        "medium",
        "Two fixed elements occupy the same screen area",
        { viewport, items: findings.overlaps },
      ),
    );
  return out;
}

/**
 * Report runtime events. `events` must be a per-step delta, never the runtime's
 * cumulative buffers: reporting the whole buffer once per action re-reports
 * every earlier event and grows quadratically with the action count.
 * Off-origin events belong to a third-party page, not to the system under test.
 */
export async function runRuntimeChecks(events = {}, stepIssues = []) {
  const out = [...stepIssues];
  const {
    console: consoleEvents = [],
    pageErrors = [],
    network = [],
    baseUrl = null,
  } = events;
  const ours = (e) => !baseUrl || !e?.url || sameOrigin(e.url, baseUrl);
  // Headless Chromium GPU stalls are environment noise, not SUT defects.
  const envNoise = (text = "") =>
    /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL/i.test(
      text,
    );
  for (const c of consoleEvents.filter(ours)) {
    if (envNoise(c.text)) continue;
    // A console warning is not a failure. Severity must track the browser.
    const warning = c.type === "warning";
    out.push(
      issue(
        "runtime",
        warning ? "Browser console warning" : "Browser console error",
        warning ? "low" : "high",
        c.text || "Console message",
        c,
      ),
    );
  }
  for (const e of pageErrors.filter(ours)) {
    out.push(
      issue("runtime", "Unhandled page error", "critical", e.message, e),
    );
  }
  for (const n of network.filter(ours)) {
    out.push(
      issue(
        "runtime",
        "Network request failed",
        "high",
        n.error || `HTTP ${n.status}`,
        n,
      ),
    );
  }
  return out;
}

export function compareScreenshots(
  beforePath,
  afterPath,
  { threshold = 0.1 } = {},
) {
  return Promise.all([readFile(beforePath), readFile(afterPath)]).then(
    ([before, after]) => {
      const a = PNG.sync.read(before);
      const b = PNG.sync.read(after);
      if (a.width !== b.width || a.height !== b.height)
        return { changed: true, ratio: 1, pixels: null };
      const diff = new PNG({ width: a.width, height: a.height });
      const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
        threshold,
      });
      return {
        changed: pixels > 0,
        ratio: pixels / (a.width * a.height),
        pixels,
      };
    },
  );
}

export function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((item) => {
    const key = `${item.type}|${item.title}|${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function verdictFor({ issues, complete }) {
  if (!complete) return "COVERAGE_INCOMPLETE";
  if (issues.some((i) => ["critical", "high"].includes(i.severity)))
    return "FAIL";
  if (issues.length) return "UNPROVEN";
  return "PASS";
}
