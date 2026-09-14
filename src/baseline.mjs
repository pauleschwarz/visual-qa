// Baseline screenshot lookup + capture helpers.
// Hierarchical: <baseline>/<route-key>/<viewport>.png
// Legacy flat:  <baseline>/<viewport>.png

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_VIEWPORTS } from "./config.mjs";

export function routeKeyFromTarget(target, baseUrl) {
  const raw = String(target ?? "").trim() || "/";
  let pathPart = raw;
  try {
    const resolved = baseUrl ? new URL(raw, baseUrl) : new URL(raw, "http://local/");
    pathPart = resolved.pathname || "/";
    if (resolved.search) pathPart += resolved.search;
  } catch {
    pathPart = raw.startsWith("/") ? raw : `/${raw}`;
  }
  const key = pathPart
    .replace(/^\//, "")
    .replace(/\/+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return key || "root";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve baseline PNG for a viewport, optionally scoped to a route key.
 * Prefer hierarchical path; fall back to flat legacy <viewport>.png.
 */
export async function resolveBaselinePath(
  baselineDir,
  viewportName,
  { routeKey = null } = {},
) {
  const root = resolve(baselineDir);
  const hierarchical =
    routeKey != null && String(routeKey).length
      ? join(root, String(routeKey), `${viewportName}.png`)
      : null;
  const flat = join(root, `${viewportName}.png`);

  if (hierarchical && (await exists(hierarchical))) {
    return {
      path: hierarchical,
      shape: "hierarchical",
      route_key: routeKey,
      viewport: viewportName,
      missing: false,
    };
  }
  if (await exists(flat)) {
    return {
      path: flat,
      shape: "legacy_flat",
      route_key: routeKey,
      viewport: viewportName,
      missing: false,
    };
  }
  return {
    path: hierarchical || flat,
    shape: hierarchical ? "hierarchical" : "legacy_flat",
    route_key: routeKey,
    viewport: viewportName,
    missing: true,
  };
}

export async function baselineMissing(
  baselineDir,
  viewportName,
  { routeKey = null } = {},
) {
  const resolved = await resolveBaselinePath(baselineDir, viewportName, {
    routeKey,
  });
  return resolved.missing;
}

/**
 * Capture named changed targets from a running URL into hierarchical baseline layout.
 * Does not start the app under test — caller supplies a live baseUrl.
 */
export async function captureBaselines({
  baseUrl,
  outDir,
  targets = ["/"],
  viewports = DEFAULT_VIEWPORTS,
  navigationTimeoutMs = 15_000,
} = {}) {
  if (!baseUrl) throw new Error("baseline-capture requires --url / baseUrl");
  const root = resolve(outDir);
  await mkdir(root, { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const captured = [];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      for (const target of targets) {
        const routeKey = routeKeyFromTarget(target, baseUrl);
        const url = new URL(target, baseUrl).toString();
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeoutMs,
        });
        await page.waitForTimeout(150);
        const dir = join(root, routeKey);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${viewport.name}.png`);
        await page.screenshot({ path: file, fullPage: false });
        captured.push({
          route_key: routeKey,
          target,
          viewport: viewport.name,
          path: file,
          url,
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const manifestPath = join(root, "baseline-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schema_version: "vqa-baseline-capture-0.1",
        base_url: baseUrl,
        captured_at: new Date().toISOString(),
        entries: captured,
      },
      null,
      2,
    )}\n`,
  );
  return { outDir: root, manifestPath, entries: captured };
}

export async function readBaselineBytes(path) {
  return readFile(path);
}
