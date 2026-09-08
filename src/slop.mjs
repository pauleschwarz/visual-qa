import { redact } from "./config.mjs";

const SCAFFOLD_TITLES = new Set([
  "My React App",
  "Vite + React",
  "Create React App",
  "Vue App",
  "Next.js",
  "Untitled",
  "Document",
  "Home",
  "Welcome",
  "New Tab",
]);
const PLACEHOLDER_RE =
  /\b(?:TODO|TBD|FIXME|XXX)\b|placeholder text|your text here|coming soon/gi;
const EMOJI_RE =
  /[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}\u{fe0f}\u{2764}]/gu;

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function makeIssue(title, severity, detail, evidence, viewport) {
  const withViewport =
    viewport === undefined ? evidence : { ...evidence, viewport };
  return {
    issue_id: `vqa-slop-${slug(title)}`,
    type: "vqa-slop",
    title,
    severity,
    detail,
    evidence: redact(withViewport),
  };
}

function emojiCount(value) {
  return value.match(EMOJI_RE)?.length ?? 0;
}

function hasEmojiSoupInText(value) {
  const characters = Array.from(value);
  if (characters.length <= 200) return emojiCount(value) >= 5;
  for (let index = 0; index <= characters.length - 200; index += 1) {
    if (emojiCount(characters.slice(index, index + 200).join("")) >= 5)
      return true;
  }
  return false;
}

export async function runSlopChecks(page, { viewport } = {}) {
  let data;
  try {
    data = await page.evaluate(() => ({
      title: document.title,
      description:
        document.querySelector('meta[name="description"]')?.getAttribute("content") ??
        null,
      text: document.body?.innerText?.slice(0, 4000) ?? "",
      headings: Array.from(document.querySelectorAll("h1, h2, h3"), (heading) =>
        heading.textContent?.trim().slice(0, 40) ?? "",
      ),
      visual: (() => {
        const viewportWidth = window.innerWidth || 1;
        const viewportHeight = window.innerHeight || 1;
        const visible = (el) => {
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            box.width >= 2 &&
            box.height >= 2 &&
            box.bottom > 0 &&
            box.right > 0 &&
            box.top < viewportHeight &&
            box.left < viewportWidth &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        };
        const heroLike = (el) =>
          /hero|banner|masthead|landing|feature/i.test(
            `${el.id || ""} ${el.className || ""}`,
          ) ||
          el.matches("header, [role='banner'], main > section:first-of-type");
        const parseColor = (value) => {
          const match = String(value || "").match(
            /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i,
          );
          if (!match) return null;
          const rgb = match.slice(1, 4).map(Number);
          const max = Math.max(...rgb) / 255;
          const min = Math.min(...rgb) / 255;
          const lightness = (max + min) / 2;
          const alpha = match[4] == null ? 1 : Number(match[4]);
          const saturation =
            max === min
              ? 0
              : (max - min) / (1 - Math.abs(2 * lightness - 1));
          return { rgb, alpha, saturation, lightness };
        };
        const vivid = (value) => {
          const color = parseColor(value);
          return (
            color &&
            color.saturation >= 0.45 &&
            color.lightness >= 0.18 &&
            color.lightness <= 0.82
          );
        };
        const colorKey = (value) => {
          const color = parseColor(value);
          if (!color) return null;
          return color.rgb.map((part) => Math.round(part / 24)).join(",");
        };
        const gradientNodes = [];
        const animatedGradientText = [];
        const glowNodes = [];
        const glassNodes = [];
        const accentColors = new Set();
        const stockLikeImages = [];
        const nodes = [...document.querySelectorAll("*")].slice(0, 3_000);
        for (const el of nodes) {
          if (!visible(el)) continue;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const backgroundImage = style.backgroundImage || "";
          const gradientLayers = (backgroundImage.match(
            /(?:linear|radial|conic)-gradient\(/gi,
          ) || []).length;
          if (gradientLayers && (heroLike(el) || box.width * box.height >= 80_000)) {
            gradientNodes.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              layers: gradientLayers,
            });
          }
          if (
            gradientLayers &&
            style.backgroundClip === "text" &&
            style.animationName &&
            style.animationName !== "none"
          ) {
            animatedGradientText.push(el.tagName.toLowerCase());
          }
          const shadow = style.boxShadow || "";
          const shadowColor = shadow.match(/rgba?\([^)]*\)/i)?.[0];
          const blurValues = (shadow.match(/-?\d+(?:\.\d+)?px/g) || []).map(
            (part) => Math.abs(Number.parseFloat(part)),
          );
          if (
            shadow !== "none" &&
            (blurValues.some((value) => value >= 12) || vivid(shadowColor)) &&
            vivid(shadowColor)
          ) {
            glowNodes.push({ tag: el.tagName.toLowerCase(), id: el.id || null });
          }
          const translucent = parseColor(style.backgroundColor);
          const backdrop =
            style.backdropFilter || style.webkitBackdropFilter || "";
          if (
            backdrop &&
            backdrop !== "none" &&
            /blur\(/i.test(backdrop) &&
            translucent &&
            translucent.alpha < 0.9
          ) {
            glassNodes.push({ tag: el.tagName.toLowerCase(), id: el.id || null });
          }
          const primaryChrome = el.matches(
            "header, nav, main > section:first-of-type, [role='banner'], [role='navigation'], button, [role='button'], [class*='hero'], [class*='primary']",
          );
          if (primaryChrome) {
            for (const color of [
              style.backgroundColor,
              style.borderTopColor,
              style.borderRightColor,
              style.borderBottomColor,
              style.borderLeftColor,
            ]) {
              const key = vivid(color) ? colorKey(color) : null;
              if (key) accentColors.add(key);
            }
          }
        }
        for (const img of document.querySelectorAll("img")) {
          if (!visible(img)) continue;
          const alt = img.getAttribute("alt");
          if (alt && alt.trim()) continue;
          const box = img.getBoundingClientRect();
          const src = img.getAttribute("src") || "";
          const stockLike = /stock|unsplash|pexels|photo|hero|banner|image/i.test(
            `${src} ${img.className || ""} ${img.id || ""}`,
          );
          const largeHero =
            heroLike(img) &&
            box.width >= viewportWidth * 0.6 &&
            box.height >= viewportHeight * 0.25;
          const explicitlyDecorative =
            img.getAttribute("role") === "presentation" || alt === "";
          if (stockLike && explicitlyDecorative && (largeHero || alt === ""))
            stockLikeImages.push({ src, role: img.getAttribute("role"), largeHero });
        }
        return {
          gradientNodes: gradientNodes.slice(0, 8),
          animatedGradientText: animatedGradientText.slice(0, 8),
          glowNodes: glowNodes.slice(0, 8),
          glassNodes: glassNodes.slice(0, 8),
          accentColors: [...accentColors].slice(0, 12),
          stockLikeImages: stockLikeImages.slice(0, 5),
        };
      })(),
    }));
  } catch (error) {
    return [
      makeIssue(
        "Slop checks unavailable",
        "medium",
        String(error),
        { error: String(error) },
        viewport,
      ),
    ];
  }

  const issues = [];
  const title = data.title ?? "";
  const text = data.text ?? "";
  const headings = Array.isArray(data.headings) ? data.headings : [];
  const copy = [text, ...headings].join("\n");

  if (!title.trim()) {
    issues.push(
      makeIssue(
        "Document title is empty",
        "high",
        "The document has no non-whitespace title.",
        { title },
        viewport,
      ),
    );
  }

  if (/lorem ipsum/i.test(`${title}\n${text}`)) {
    issues.push(
      makeIssue(
        "Lorem ipsum placeholder copy",
        "high",
        "Lorem ipsum placeholder copy appears in the title or visible text.",
        { title, match: "Lorem ipsum" },
        viewport,
      ),
    );
  }

  const placeholderMatches = [
    ...new Set(copy.match(PLACEHOLDER_RE) ?? []),
  ].slice(0, 5);
  if (placeholderMatches.length) {
    issues.push(
      makeIssue(
        "Placeholder copy left in the UI",
        "medium",
        "Placeholder markers appear in visible text or headings.",
        { matches: placeholderMatches },
        viewport,
      ),
    );
  }

  if (SCAFFOLD_TITLES.has(title.trim())) {
    issues.push(
      makeIssue(
        "Scaffold-default document title",
        "high",
        "The document title matches a common scaffold default.",
        { title },
        viewport,
      ),
    );
  }

  if (emojiCount(title) >= 5 || hasEmojiSoupInText(text)) {
    issues.push(
      makeIssue(
        "Emoji-heavy decorative text",
        "low",
        "The title or visible text contains at least five emoji characters in a 200-character window.",
        { title, emoji_count: emojiCount(title), text_emoji_count: emojiCount(text) },
        viewport,
      ),
    );
  }

  const headingCounts = new Map();
  for (const heading of headings) {
    const normalized = heading.trim().toLowerCase();
    if (!normalized) continue;
    const current = headingCounts.get(normalized);
    if (current) {
      current.count += 1;
    } else {
      headingCounts.set(normalized, { text: heading.trim(), count: 1 });
    }
  }
  const repeatedHeading = [...headingCounts.values()].find(
    ({ count }) => count >= 4,
  );
  if (repeatedHeading) {
    issues.push(
      makeIssue(
        "Repeated identical headings",
        "medium",
        `The heading appears ${repeatedHeading.count} times.`,
        { heading: repeatedHeading.text, count: repeatedHeading.count },
        viewport,
      ),
    );
  }

  if (data.description == null || !data.description.trim()) {
    issues.push(
      makeIssue(
        "Meta description missing",
        "low",
        "The page does not provide a non-empty meta description.",
        { description: data.description },
        viewport,
      ),
    );
  }

  const visual = data.visual || {};
  if (
    (visual.gradientNodes?.length ?? 0) >= 3 ||
    (visual.animatedGradientText?.length ?? 0) > 0
  ) {
    issues.push(
      makeIssue(
        "Gradient soup / mesh-style chrome",
        "medium",
        "Several large or hero-like nodes use gradients, or animated gradient text is present.",
        {
          nodes: visual.gradientNodes,
          animated_gradient_text: visual.animatedGradientText,
        },
        viewport,
      ),
    );
  }
  if ((visual.glowNodes?.length ?? 0) >= 3) {
    issues.push(
      makeIssue(
        "Glow / neon overuse",
        "medium",
        "Multiple visible elements use saturated or large-blur box shadows.",
        { nodes: visual.glowNodes },
        viewport,
      ),
    );
  }
  if ((visual.glassNodes?.length ?? 0) >= 3) {
    issues.push(
      makeIssue(
        "Glassmorphism overuse",
        "low",
        "Multiple visible nodes combine backdrop blur with translucent backgrounds.",
        { nodes: visual.glassNodes },
        viewport,
      ),
    );
  }
  if ((visual.accentColors?.length ?? 0) > 2) {
    issues.push(
      makeIssue(
        "Rainbow / multi-accent chrome",
        "low",
        "Primary chrome uses more than two distinct vivid accent colors in this viewport.",
        { colors: visual.accentColors.slice(0, 6) },
        viewport,
      ),
    );
  }
  if ((visual.stockLikeImages?.length ?? 0) > 0) {
    issues.push(
      makeIssue(
        "Decorative stock-photo image lacks meaningful alt text",
        "low",
        "A stock-photo-like decorative image is missing meaningful alternative text.",
        { images: visual.stockLikeImages },
        viewport,
      ),
    );
  }

  return issues.slice(0, 12);
}
