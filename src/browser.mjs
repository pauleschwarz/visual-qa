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

export class BrowserRuntime {
  constructor({ baseUrl, viewport, trace = true, outDir }) {
    this.baseUrl = baseUrl;
    this.viewport = viewport;
    this.trace = trace;
    this.outDir = outDir;
    this.console = [];
    this.pageErrors = [];
    this.network = [];
  }

  async start() {
    this.browser = await chromium.launch();
    this.context = await this.browser.newContext({
      viewport: { width: this.viewport.width, height: this.viewport.height },
      reducedMotion: "reduce",
      // Deterministic rendering: no locale/timezone drift between runs.
      locale: "en-US",
      timezoneId: "UTC",
    });
    if (this.trace) {
      await this.context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
    }
    this.page = await this.context.newPage();
    this.#attachListeners(this.page);
    // Suppress animations so screenshot stabilization converges.
    await this.context.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent =
        "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}";
      document.addEventListener("DOMContentLoaded", () => document.head?.appendChild(style));
    });
    return this;
  }

  #attachListeners(page) {
    page.on("console", (msg) => {
      if (msg.type() !== "error" && msg.type() !== "warning") return;
      this.console.push(
        redact({ type: msg.type(), text: msg.text(), at: this.#mark(), url: page.url() }),
      );
    });
    page.on("pageerror", (err) => {
      this.pageErrors.push(redact({ message: err.message, at: this.#mark(), url: page.url() }));
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
        redact({ kind: "http", url: res.url(), status, method: res.request().method(), at: this.#mark() }),
      );
    });
  }

  #mark() {
    return this._mark || "boot";
  }

  /** Correlate subsequent runtime events with the action that caused them. */
  markStep(id) {
    this._mark = id;
    const before = { console: this.console.length, errors: this.pageErrors.length, net: this.network.length };
    return () => ({
      console: this.console.slice(before.console),
      pageErrors: this.pageErrors.slice(before.errors),
      network: this.network.slice(before.net),
    });
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await this.waitForStableState();
  }

  /** fonts.ready + two byte-identical frames. Cheap, deterministic, no sleeps. */
  async waitForStableState({ frames = 5, gap = 80 } = {}) {
    await this.page.evaluate(() => document.fonts?.ready).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    let prev = null;
    for (let i = 0; i < frames; i++) {
      const buf = await this.page.screenshot({ type: "png", animations: "disabled" }).catch(() => null);
      if (buf && prev && Buffer.compare(buf, prev) === 0) return true;
      prev = buf;
      await this.page.waitForTimeout(gap);
    }
    return false;
  }

  async ariaSnapshot() {
    try {
      return await this.page.locator("body").ariaSnapshot({ timeout: 4000 });
    } catch {
      return "";
    }
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
          return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
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
              document.getElementById(el.getAttribute("aria-labelledby"))?.textContent) ||
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
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") || null,
            href: el.getAttribute("href") || null,
            testId: el.getAttribute("data-testid") || el.getAttribute("data-test-id") || null,
            required: el.hasAttribute("required"),
            min: el.getAttribute("min"),
            max: el.getAttribute("max"),
            maxLength: el.getAttribute("maxlength"),
            pattern: el.getAttribute("pattern"),
            // Component signature: repeated cards share this, enabling sampling.
            signature: `${role}|${el.className || ""}|${el.parentElement?.className || ""}`.slice(0, 120),
            box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
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
    return kept.map((c, i) => ({ ...c, index: i }));
  }

  /** Resolve a control to a Playwright locator using semantic selectors first. */
  locate(control) {
    const p = this.page;
    if (control.testId) return p.locator(`[data-testid="${control.testId}"]`).first();
    if (control.name) {
      const byRole = p.getByRole(control.role, { name: control.name, exact: false });
      return byRole.first();
    }
    return p.locator(control.tag).nth(Math.max(0, (control.sampledFrom || 1) - 1));
  }

  async click(control) {
    await this.locate(control).click({ timeout: 5000 });
    await this.waitForStableState();
  }

  async fill(control, value) {
    await this.locate(control).fill(String(value), { timeout: 5000 });
  }

  async press(key) {
    await this.page.keyboard.press(key);
    await this.waitForStableState({ frames: 3 });
  }

  async back() {
    await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await this.waitForStableState();
  }

  async screenshot(path, { fullPage = false } = {}) {
    await this.waitForStableState({ frames: 3 });
    return this.page.screenshot({ path, fullPage, animations: "disabled", caret: "hide" });
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
