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
  /\b(?:TODO|TBD|FIXME|XXX)\b|placeholder text|your text here|coming soon|lorem ipsum|dolor sit amet|consectetur adipiscing|sample text|dummy text|click here|learn more(?!\s+about)|get started now/gi;
// Fake-SaaS / AI-template marketing fluff that almost never belongs in product UI.
const MARKETING_FLOFF_RE =
  /\b(?:supercharge|revolutionize|unlock the power|next-?gen(?:eration)?|seamless(?:ly)?|cutting-?edge|game-?chang(?:er|ing)|one-?stop shop|all-in-one platform|ai-powered|powered by ai|delight(?:ful)? experience|world-?class|best-in-class|transform your|elevate your|reimagine|disrupt(?:ive|ion)?|synerg(?:y|ies)|holistic approach|leverage our|empower(?:ing)? (?:your|teams?)|10x your)\b/gi;
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
        const fontFamilies = new Set();
        const fontSizes = new Map();
        const radiusBuckets = new Map();
        const marginGaps = new Map();
        const centeredCardBlocks = [];
        let featureCardPattern = 0;
        const nodes = [...document.querySelectorAll("*")].slice(0, 3_000);
        for (const el of nodes) {
          if (!visible(el)) continue;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          // Type + chrome rhythm samples (body text and controls only).
          const tag = el.tagName.toLowerCase();
          if (
            ["p", "li", "span", "a", "button", "label", "h1", "h2", "h3", "h4"].includes(
              tag,
            ) ||
            el.getAttribute("role") === "button"
          ) {
            const family = (style.fontFamily || "")
              .split(",")[0]
              .replace(/["']/g, "")
              .trim()
              .toLowerCase();
            if (family) fontFamilies.add(family);
            const size = Math.round(Number.parseFloat(style.fontSize) || 0);
            if (size >= 10 && size <= 72) {
              fontSizes.set(size, (fontSizes.get(size) || 0) + 1);
            }
            const radius = Math.round(Number.parseFloat(style.borderRadius) || 0);
            if (radius > 0 && radius <= 64 && box.width * box.height >= 400) {
              radiusBuckets.set(radius, (radiusBuckets.get(radius) || 0) + 1);
            }
            const mt = Math.round(Number.parseFloat(style.marginTop) || 0);
            if (mt >= 4 && mt <= 96) {
              marginGaps.set(mt, (marginGaps.get(mt) || 0) + 1);
            }
          }
          // Template "3 equal feature cards" heuristic: same-sized card children.
          if (
            (tag === "section" || tag === "div" || tag === "ul") &&
            el.children.length >= 3 &&
            el.children.length <= 6
          ) {
            const kids = [...el.children].filter(visible);
            if (kids.length >= 3) {
              const widths = kids.map((c) => Math.round(c.getBoundingClientRect().width));
              const heights = kids.map((c) => Math.round(c.getBoundingClientRect().height));
              const w0 = widths[0];
              const h0 = heights[0];
              const uniform =
                widths.every((w) => Math.abs(w - w0) <= 8) &&
                heights.every((h) => Math.abs(h - h0) <= 12) &&
                w0 >= 140 &&
                h0 >= 80;
              if (uniform) featureCardPattern += 1;
            }
          }
          // Centered marketing block with long uppercase-ish CTA density.
          if (
            (tag === "section" || tag === "div" || tag === "header") &&
            box.width >= viewportWidth * 0.5 &&
            box.height >= 120
          ) {
            const textAlign = style.textAlign;
            const buttons = [...el.querySelectorAll("button, a")].filter(visible);
            if (
              (textAlign === "center" || style.justifyContent === "center") &&
              buttons.length >= 1 &&
              buttons.length <= 3
            ) {
              centeredCardBlocks.push({
                tag,
                id: el.id || null,
                buttons: buttons.length,
              });
            }
          }
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
          fontFamilies: [...fontFamilies].slice(0, 8),
          fontSizeCount: fontSizes.size,
          fontSizes: [...fontSizes.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([size, count]) => ({ size, count })),
          radiusCount: radiusBuckets.size,
          radii: [...radiusBuckets.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([radius, count]) => ({ radius, count })),
          marginGapCount: marginGaps.size,
          marginGaps: [...marginGaps.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([gap, count]) => ({ gap, count })),
          featureCardPattern,
          centeredCardBlocks: centeredCardBlocks.slice(0, 6),
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

  const marketingMatches = [
    ...new Set(copy.match(MARKETING_FLOFF_RE) ?? []),
  ].slice(0, 6);
  if (marketingMatches.length >= 2) {
    issues.push(
      makeIssue(
        "Fake-SaaS / AI marketing fluff copy",
        "medium",
        "Product UI copy leans on generic template marketing phrases a careful reviewer would reject.",
        { matches: marketingMatches },
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

  if ((visual.fontFamilies?.length ?? 0) > 2) {
    issues.push(
      makeIssue(
        "Too many font families",
        "medium",
        "Visible text uses more than two primary font families — type system looks accidental.",
        { families: visual.fontFamilies },
        viewport,
      ),
    );
  }

  if ((visual.fontSizeCount ?? 0) >= 7) {
    issues.push(
      makeIssue(
        "Type scale is chaotic",
        "medium",
        "Seven or more distinct font sizes appear in body/chrome text; hierarchy reads as random rather than designed.",
        { sizes: visual.fontSizes },
        viewport,
      ),
    );
  }

  if ((visual.radiusCount ?? 0) >= 5) {
    issues.push(
      makeIssue(
        "Inconsistent corner radii",
        "low",
        "Five or more distinct border-radius values on visible chrome; cards/controls do not share one system.",
        { radii: visual.radii },
        viewport,
      ),
    );
  }

  if ((visual.marginGapCount ?? 0) >= 8) {
    issues.push(
      makeIssue(
        "Spacing rhythm is irregular",
        "medium",
        "Eight or more distinct margin-top gaps on text/controls; spacing looks hand-tweaked, not on a scale.",
        { gaps: visual.marginGaps },
        viewport,
      ),
    );
  }

  if ((visual.featureCardPattern ?? 0) >= 1 && (visual.gradientNodes?.length ?? 0) >= 1) {
    issues.push(
      makeIssue(
        "Generic template feature-card chrome",
        "medium",
        "Uniform equal-sized feature cards sit with gradient chrome — classic AI/template landing pattern without product voice.",
        {
          feature_card_groups: visual.featureCardPattern,
          gradients: visual.gradientNodes?.length ?? 0,
        },
        viewport,
      ),
    );
  }

  if ((visual.centeredCardBlocks?.length ?? 0) >= 3 && marketingMatches.length >= 1) {
    issues.push(
      makeIssue(
        "Centered marketing blocks without product specificity",
        "low",
        "Multiple large centered CTA blocks plus fluff phrases — looks like a stock SaaS landing, not this product.",
        {
          blocks: visual.centeredCardBlocks,
          fluff: marketingMatches,
        },
        viewport,
      ),
    );
  }

  return issues.slice(0, 18);
}
