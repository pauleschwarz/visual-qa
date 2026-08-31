// Visual QA - Playwright execution kernel.
//
// Deterministic browser mechanics only. No model ever drives a click; the
// explorer chooses, this module executes and observes.

import { chromium } from "playwright";
import { redact } from "./config.mjs";

const SEMANTIC_ROLES = [
  "button",
  "link",
  "tab",
  "menuitem",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
  "option",
];

function escapeSelector(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

export class BrowserRuntime {
  constructor({
    baseUrl,
    viewport,
    trace = true,
    outDir,
    stableFrames = 2,
    stableGap = 30,
    navigationTimeout = 15_000,
  }) {
    this.baseUrl = baseUrl;
    this.viewport = viewport;
    this.trace = trace;
    this.outDir = outDir;
    this.stableFrames = stableFrames;
    this.stableGap = stableGap;
    this.navigationTimeout = navigationTimeout;
    this.console = [];
    this.pageErrors = [];
    this.network = [];
  }

  async start() {
    // Headless Chromium falls back to software GL, which drops a WebGL page to
    // ~3fps and turns every click into a stability timeout — a measurement
    // artifact reported as a product defect. Ask for real GPU rendering and
    // fall back to the default launch where that is unavailable.
    this.browser = await chromium
      .launch({ args: ["--use-gl=angle", "--enable-gpu"] })
      .catch(() => chromium.launch());
    this.context = await this.browser.newContext({
      viewport: { width: this.viewport.width, height: this.viewport.height },
      reducedMotion: "reduce",
      // Deterministic rendering: no locale/timezone drift between runs.
      locale: "en-US",
      timezoneId: "UTC",
    });
    if (this.trace) {
      await this.context.tracing
        .start({ screenshots: true, snapshots: true })
        .catch(() => {});
    }
    this.page = await this.context.newPage();
    this.#attachListeners(this.page);
    // Suppress animations so screenshot stabilization converges.
    await this.context.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent =
        "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}";
      document.addEventListener("DOMContentLoaded", () =>
        document.head?.appendChild(style),
      );
    });
    return this;
  }

  #attachListeners(page) {
    page.on("console", (msg) => {
      if (msg.type() !== "error" && msg.type() !== "warning") return;
      this.console.push(
        redact({
          type: msg.type(),
          text: msg.text(),
          at: this.#mark(),
          url: page.url(),
        }),
      );
    });
    page.on("pageerror", (err) => {
      this.pageErrors.push(
        redact({ message: err.message, at: this.#mark(), url: page.url() }),
      );
    });
    page.on("requestfailed", (req) => {
      this.network.push(
        redact({
          kind: "requestfailed",
          url: req.url(),
          method: req.method(),
          error: req.failure()?.errorText,
          at: this.#mark(),
        }),
      );
    });
    page.on("response", (res) => {
      const status = res.status();
      if (status < 400) return;
      this.network.push(
        redact({
          kind: "http",
          url: res.url(),
          status,
          method: res.request().method(),
          at: this.#mark(),
        }),
      );
    });
  }

  #mark() {
    return this._mark || "boot";
  }

  /** Correlate subsequent runtime events with the action that caused them. */
  markStep(id) {
    this._mark = id;
    const before = {
      console: this.console.length,
      errors: this.pageErrors.length,
      net: this.network.length,
    };
    return () => ({
      console: this.console.slice(before.console),
      pageErrors: this.pageErrors.slice(before.errors),
      network: this.network.slice(before.net),
    });
  }

  // Network quiescence belongs to navigation, not to every stability probe:
  // paying a 2s idle timeout per screenshot pushed step time past 16s and the
  // run hit its wall clock before the second viewport ever started.
  async navigate(url) {
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.navigationTimeout,
    });
    await this.waitForStableState({
      frames: this.stableFrames,
      gap: this.stableGap,
    });
  }

  /**
   * Stability is a DOM/layout property, not a pixel property: a page with a
   * permanently animating canvas never produces two identical frames, so a
   * screenshot-diff wait burned seconds per step and always timed out. Compare
   * a cheap in-page layout signature across animation frames instead.
   */
  async waitForStableState({ frames = 2, gap = 30 } = {}) {
    await this.page.evaluate(() => document.fonts?.ready).catch(() => {});
    return this.page
      .evaluate(
        async ([rounds, delay]) => {
          const tick = () =>
            new Promise((resolve) => requestAnimationFrame(() => resolve()));
          const wait = (ms) =>
            new Promise((resolve) => setTimeout(resolve, ms));
          const signature = () => {
            const parts = [
              document.documentElement.scrollHeight,
              window.scrollY,
              document.readyState,
            ];
            for (const el of document.querySelectorAll(
              "a,button,input,select,textarea,[role],h1,h2,h3",
            )) {
              const r = el.getBoundingClientRect();
              parts.push(
                `${el.tagName}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}:${(el.textContent || "").slice(0, 40)}`,
              );
            }
            return parts.join("|");
          };
          let prev = null;
          for (let i = 0; i < Math.max(2, rounds) + 6; i++) {
            await tick();
            const now = signature();
            if (prev !== null && now === prev) return true;
            prev = now;
            await wait(delay);
          }
          return false;
        },
        [frames, gap],
      )
      .catch(() => false);
  }

  async ariaSnapshot() {
    try {
      return await this.page.locator("body").ariaSnapshot({ timeout: 4000 });
    } catch {
      return "";
    }
  }

  async domSnapshot() {
    return this.page
      .evaluate(() => document.documentElement.outerHTML.slice(0, 200_000))
      .catch(() => "");
  }

  async focusSnapshot() {
    return this.page
      .evaluate(() => {
        const active = document.activeElement;
        return {
          tag: active?.tagName?.toLowerCase() || null,
          name:
            active?.getAttribute?.("aria-label") ||
            active?.textContent?.trim()?.slice(0, 80) ||
            null,
          id: active?.id || null,
        };
      })
      .catch(() => ({ tag: null, name: null, id: null }));
  }

  async headings() {
    return this.page
      .evaluate(() =>
        [...document.querySelectorAll("h1,h2,h3")]
          .map((h) => h.textContent?.trim() || "")
          .filter(Boolean)
          .slice(0, 12),
      )
      .catch(() => []);
  }

  async dialogOpen() {
    return this.page
      .evaluate(
        () =>
          !!document.querySelector(
            'dialog[open], [role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])',
          ),
      )
      .catch(() => false);
  }

  /** Document-level theme / color-scheme signal for state identity. */
  async themeSignal() {
    return this.page
      .evaluate(() => {
        const root = document.documentElement;
        return (
          root.dataset.theme ||
          root.getAttribute("data-theme") ||
          root.getAttribute("data-color-scheme") ||
          root.style.colorScheme ||
          ""
        );
      })
      .catch(() => "");
  }

  /**
   * Re-enter an explored state before branching. URL is the primary key;
   * optional theme is restored so localStorage-sticky themes cannot drift.
   */
  async restoreState({ url, theme } = {}) {
    if (url) await this.navigate(url);
    if (theme) {
      // Site-agnostic: mirror the theme onto the documented root signal and
      // into whichever storage key already holds a theme token. Hard-coding
      // one product's selectors would make restore silently wrong elsewhere.
      await this.page
        .evaluate((value) => {
          const root = document.documentElement;
          root.dataset.theme = value;
          root.style.colorScheme = value;
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (/^(light|dark|auto|system)$/i.test(localStorage.getItem(key)))
                localStorage.setItem(key, value);
            }
          } catch {
            /* private mode */
          }
          for (const el of document.querySelectorAll("[aria-pressed]")) {
            const scheme = el.dataset.theme || el.dataset.setTheme;
            if (scheme)
              el.setAttribute("aria-pressed", String(scheme === value));
          }
        }, theme)
        .catch(() => {});
      await this.waitForStableState({
        frames: this.stableFrames,
        gap: this.stableGap,
      });
    }
  }

  /**
   * Inventory interactive controls via the accessibility tree, not CSS.
   * Returns a stable, ranked, deduplicated list with semantic locators.
   */
  async inventory() {
    const raw = await this.page
      .evaluate((roles) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const s = getComputedStyle(el);
          return (
            s.visibility !== "hidden" &&
            s.display !== "none" &&
            s.opacity !== "0"
          );
        };
        const roleOf = (el) => {
          const explicit = el.getAttribute("role");
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
          if (tag === "button") return "button";
          if (tag === "select") return "combobox";
          if (tag === "textarea") return "textbox";
          if (tag === "input") {
            const t = (el.getAttribute("type") || "text").toLowerCase();
            if (["checkbox"].includes(t)) return "checkbox";
            if (["radio"].includes(t)) return "radio";
            if (["submit", "button", "reset"].includes(t)) return "button";
            if (t === "search") return "searchbox";
            return "textbox";
          }
          return "generic";
        };
        const nameOf = (el) =>
          (
            el.getAttribute("aria-label") ||
            (el.getAttribute("aria-labelledby") &&
              document.getElementById(el.getAttribute("aria-labelledby"))
                ?.textContent) ||
            el.labels?.[0]?.textContent ||
            el.getAttribute("placeholder") ||
            el.getAttribute("alt") ||
            el.getAttribute("title") ||
            el.value ||
            el.textContent ||
            ""
          )
            .trim()
            .slice(0, 80);

        const nodes = [
          ...document.querySelectorAll(
            "a[href],button,input,select,textarea,summary,[role],[tabindex]:not([tabindex='-1'])",
          ),
        ];
        const out = [];
        for (const el of nodes) {
          const role = roleOf(el);
          if (!roles.includes(role)) continue;
          if (el.disabled) continue;
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          out.push({
            role,
            name: nameOf(el),
            id: el.id || null,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") || null,
            href: el.getAttribute("href") || null,
            testId:
              el.getAttribute("data-testid") ||
              el.getAttribute("data-test-id") ||
              null,
            required: el.hasAttribute("required"),
            min: el.getAttribute("min"),
            max: el.getAttribute("max"),
            maxLength: el.getAttribute("maxlength"),
            pattern: el.getAttribute("pattern"),
            pressed: el.getAttribute("aria-pressed"),
            current: el.getAttribute("aria-current"),
            // Component signature: repeated cards share this, enabling sampling.
            signature:
              `${role}|${el.id || el.className || ""}|${el.parentElement?.className || ""}`.slice(
                0,
                120,
              ),
            box: {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
            inViewport: r.top < window.innerHeight && r.bottom > 0,
          });
        }
        return out;
      }, SEMANTIC_ROLES)
      .catch(() => []);

    // Deduplicate identical component instances: keep at most 2 per signature.
    const perSignature = new Map();
    const kept = [];
    for (const c of raw) {
      const key = `${c.signature}|${c.role}`;
      const n = (perSignature.get(key) || 0) + 1;
      perSignature.set(key, n);
      c.sampledFrom = n;
      if (n <= 2) kept.push(c);
    }
    // Positional identity for locator resolution: DOM order is stable across
    // inventory and live queries, so per-name and per-tag occurrence indices
    // are what lets `locate()` pick the exact instance among duplicate names
    // (the default case in any card list) instead of a `.first()` guess.
    const nameCounts = new Map();
    const tagCounts = new Map();
    for (const c of raw) {
      const nameKey = `${c.role}|${(c.name || "").toLowerCase()}`;
      c.nameIndex = nameCounts.get(nameKey) || 0;
      nameCounts.set(nameKey, c.nameIndex + 1);
      c.tagIndex = tagCounts.get(c.tag) || 0;
      tagCounts.set(c.tag, c.tagIndex + 1);
    }
    return kept.map((c, i) => ({ ...c, index: i }));
  }

  /** Resolve a control to a Playwright locator using semantic selectors first. */
  async locate(control) {
    const p = this.page;
    if (control.testId)
      return p.locator(`[data-testid="${escapeSelector(control.testId)}"]`).first();
    if (control.id) return p.locator(`#${escapeSelector(control.id)}`).first();
    const name = String(control.name || "").trim();
    if (name) {
      const idx = Math.max(0, control.nameIndex || 0);
      // Full accessible-name match first: substring matching otherwise
      // resolves "Save" onto a "Save draft" sibling whenever it sorts earlier.
      const exact = p.getByRole(control.role, { name, exact: true }).nth(idx);
      if ((await exact.count().catch(() => 0)) > 0) return exact;
      // nameOf falls back to non-accessible sources (value, truncated text);
      // substring keeps those controls resolvable.
      const fuzzy = p.getByRole(control.role, { name, exact: false }).nth(idx);
      if ((await fuzzy.count().catch(() => 0)) > 0) return fuzzy;
    }
    // Deterministic positional fallback: nth over the tag in DOM order.
    const positional = p
      .locator(control.tag || "*")
      .nth(Math.max(0, control.tagIndex || 0));
    if ((await positional.count().catch(() => 0)) > 0) return positional;
    return p.locator(control.tag || "*").first();
  }

  async click(control) {
    await (await this.locate(control)).click({ timeout: 5000 });
    await this.waitForStableState();
  }

  async fill(control, value) {
    await (await this.locate(control)).fill(String(value), { timeout: 5000 });
  }

  async press(key) {
    await this.page.keyboard.press(key);
    await this.waitForStableState({ frames: 2, gap: 15 });
  }

  async back() {
    await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await this.waitForStableState();
  }

  async screenshot(path, { fullPage = false, stable = true } = {}) {
    if (stable) await this.waitForStableState({ frames: 2, gap: 15 });
    return this.page.screenshot({
      path,
      fullPage,
      animations: "disabled",
      caret: "hide",
    });
  }

  async visibleText(limit = 1200) {
    return this.page
      .evaluate(() => document.body?.innerText || "")
      .then((t) => t.replace(/\s+/g, " ").trim().slice(0, limit))
      .catch(() => "");
  }

  async stop(tracePath) {
    if (this.trace && tracePath) {
      await this.context?.tracing.stop({ path: tracePath }).catch(() => {});
    }
    await this.browser?.close().catch(() => {});
  }
}
