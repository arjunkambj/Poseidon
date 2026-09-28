/**
 * What a plan's card needs to take the plan elsewhere, as pure functions:
 *
 * - **Implement in new thread:** the new thread's title — the plan's first
 *   Markdown heading, else "<title> (plan)" — and its first message.
 * - **Save as .md:** the file name the path field opens on — a slug of that
 *   heading, else `plan.md` — and why a typed path cannot be saved, so the
 *   field says so before the server has to (`files.create` refuses the same
 *   paths).
 */

/** The longest slug a default file name gets, before `.md`. */
const SLUG_MAX = 60;

/** Inline Markdown a heading may carry that a title does not want. */
const INLINE_MARKUP = /[*_`~]|\[([^\]]*)\]\([^)]*\)/g;

/**
 * The text of the plan's first ATX heading (`#` to `######`), without its
 * hashes, closing hashes or inline markup; `null` when it has none. Headings
 * inside fenced code blocks are skipped.
 */
export const planHeading = (markdown: string): string | null => {
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (match === null) continue;
    const text = (match[1] ?? "").replace(INLINE_MARKUP, "$1").replace(/\s+/g, " ").trim();
    if (text.length > 0) return text;
  }
  return null;
};

/** The title "Implement in new thread" opens its dialog on. */
export const planThreadTitle = (markdown: string, sourceTitle: string): string =>
  planHeading(markdown) ?? `${sourceTitle} (plan)`;

/** The new thread's first message: the plan, whole, under one line that says what to do. */
export const implementPlanMessage = (markdown: string): string =>
  `Implement this plan:\n\n${markdown.trim()}`;

/** Lowercase words joined by dashes, at most `SLUG_MAX` characters; `""` when nothing is left. */
const slugOf = (text: string): string =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");

/** The path Save as .md suggests, at the workspace root. */
export const planFileName = (markdown: string): string => {
  // "Add CHANGELOG.md" names a file the plan is about; its extension would
  // only come back doubled ("add-changelog-md.md").
  const slug = slugOf((planHeading(markdown) ?? "").replace(/\.md\b/gi, ""));
  return `${slug.length === 0 ? "plan" : slug}.md`;
};

/** Why `path` cannot be saved, or `null`; the server makes the same checks. */
export const planPathProblem = (path: string): string | null => {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return "Enter a file name.";
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return "Use a path inside the workspace, like docs/plan.md.";
  }
  if (trimmed.split(/[\\/]/).includes("..")) {
    return "The file has to stay inside the workspace.";
  }
  if (!trimmed.toLowerCase().endsWith(".md") || /[\\/]\.md$|^\.md$/i.test(trimmed)) {
    return "The file name has to end in .md.";
  }
  return null;
};
