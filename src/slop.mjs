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

  return issues.slice(0, 8);
}
