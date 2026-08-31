// Security probes stay deterministic and bounded; availability failures remain silent.

import { redact } from "./config.mjs";

const EVIL_ORIGIN = "https://vqa-evil.example";
const CANARY = '"><b id="vqa-xss-canary">vqa</b>';
const CANARY_TIMEOUT = Symbol("canary-timeout");
const SECURITY_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
];
const STORAGE_PATTERNS = [
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /sk-[A-Za-z0-9]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /-----BEGIN/,
];

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function issue(title, severity, detail, evidence, viewport) {
  const fullEvidence =
    viewport === undefined ? evidence : { ...evidence, viewport };
  return {
    issue_id: `vqa-security-${slug(title)}`,
    type: "vqa-security",
    title,
    severity,
    detail,
    evidence: redact(fullEvidence),
  };
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function beforeDeadline(operation, deadline) {
  const timeout = remainingMs(deadline);
  if (!timeout) return CANARY_TIMEOUT;
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(CANARY_TIMEOUT), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runStorageProbe(page, viewport) {
  const locations = await page.evaluate((patterns) => {
    const matches = (value) =>
      patterns.some((pattern) => new RegExp(pattern).test(value));
    const found = [];

    for (const storageName of ["localStorage", "sessionStorage"]) {
      const storage = window[storageName];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const value = storage.getItem(key) || "";
        if (matches(`${key}\n${value}`)) {
          found.push(key);
        }
      }
    }

    for (const cookie of document.cookie.split(";")) {
      const separator = cookie.indexOf("=");
      const key = cookie.slice(0, separator < 0 ? cookie.length : separator).trim();
      const value = separator < 0 ? "" : cookie.slice(separator + 1);
      if (key && matches(`${key}\n${value}`)) {
        found.push(key);
      }
    }

    return [...new Set(found)];
  }, STORAGE_PATTERNS.map((pattern) => pattern.source));

  if (locations.length) {
    return issue(
      "Secret exposed in client storage",
      "high",
      "A secret-like value is readable from client-side storage.",
      { locations },
      viewport,
    );
  }
  return null;
}

async function runCanaryProbe(page, viewport) {
  const deadline = Date.now() + 10_000;
  const candidates = await beforeDeadline(
    () =>
      page.evaluate(() => {
        const selector =
          "input[type=text],input[type=search],input[type=email],input[type=url],input[type=tel],input:not([type])";
        const inputs = [...document.querySelectorAll(selector)];
        return inputs
          .filter((input) => {
            const style = getComputedStyle(input);
            const rect = input.getBoundingClientRect();
            return (
              !input.disabled &&
              input.getClientRects().length > 0 &&
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          })
          .slice(0, 3)
          .map((input) => {
            const id = input.id ? `#${CSS.escape(input.id)}` : "";
            return {
              label: `${input.tagName.toLowerCase()}${id}`,
              selector: id ? `input${id}` : selector,
              nth: id ? 0 : inputs.indexOf(input),
            };
          });
      }),
    deadline,
  );

  if (candidates === CANARY_TIMEOUT) return [];
  const findings = [];

  for (const candidate of candidates) {
    const locator = page.locator(candidate.selector).nth(candidate.nth);
    let original;

    try {
      original = await beforeDeadline(
        () => locator.inputValue({ timeout: remainingMs(deadline) }),
        deadline,
      );
      if (original === CANARY_TIMEOUT) return findings;

      const filled = await beforeDeadline(
        () => locator.fill(CANARY, { timeout: remainingMs(deadline) }),
        deadline,
      );
      if (filled === CANARY_TIMEOUT) return findings;

      const pressed = await beforeDeadline(
        () => locator.press("Tab", { timeout: remainingMs(deadline) }),
        deadline,
      );
      if (pressed === CANARY_TIMEOUT) return findings;

      const rendered = await beforeDeadline(
        () =>
          page.evaluate(
            () => Boolean(document.querySelector("#vqa-xss-canary")),
          ),
        deadline,
      );
      if (rendered === true) {
        findings.push(
          issue(
            "Unescaped HTML reflection in input handling",
            "high",
            "Input text was reflected as parsed HTML after the field lost focus.",
            { input: candidate.label, canary_rendered: true },
            viewport,
          ),
        );
        return findings;
      }
      if (rendered === CANARY_TIMEOUT) return findings;
    } finally {
      if (original !== undefined && original !== CANARY_TIMEOUT && remainingMs(deadline) > 0) {
        await beforeDeadline(
          () => locator.fill(original, { timeout: remainingMs(deadline) }),
          deadline,
        );
      }
    }
  }

  return findings;
}

export async function runSecurityChecks({ page, baseUrl, viewport } = {}) {
  const issues = [];

  try {
    const res = await page.request.get(baseUrl);
    const headers = res.headers();
    const missing = SECURITY_HEADERS.filter(
      (header) => !String(headers[header] || "").trim(),
    ).map((header) => ({ header, note: "Response header is missing." }));
    if (missing.length) {
      issues.push(
        issue(
          "Security headers missing",
          "medium",
          "The response is missing recommended browser security headers.",
          { items: missing, status: res.status() },
          viewport,
        ),
      );
    }
  } catch {
    // Skip unavailable HTTP header probe; capability noise is not a finding.
  }

  try {
    const res = await page.request.get(baseUrl, {
      headers: { Origin: EVIL_ORIGIN },
    });
    const headers = res.headers();
    const allowOrigin = String(
      headers["access-control-allow-origin"] || "",
    ).trim();
    const allowCredentials = String(
      headers["access-control-allow-credentials"] || "",
    ).trim();
    const echoesEvilOrigin = allowOrigin
      .split(",")
      .some((origin) => origin.trim() === EVIL_ORIGIN);
    const wildcardWithCredentials =
      allowOrigin === "*" && allowCredentials.toLowerCase() === "true";

    if (echoesEvilOrigin || wildcardWithCredentials) {
      issues.push(
        issue(
          "Permissive cross-origin policy",
          "high",
          "The response permits the hostile Origin in its cross-origin policy.",
          {
            allow_origin: allowOrigin,
            allow_credentials: allowCredentials || null,
          },
          viewport,
        ),
      );
    }
  } catch {
    // Skip unavailable CORS probe; capability noise is not a finding.
  }

  try {
    const finding = await runStorageProbe(page, viewport);
    if (finding) issues.push(finding);
  } catch {
    // Skip unavailable storage probe; capability noise is not a finding.
  }

  try {
    issues.push(...(await runCanaryProbe(page, viewport)));
  } catch {
    // Skip unavailable canary probe; capability noise is not a finding.
  }

  return issues;
}
