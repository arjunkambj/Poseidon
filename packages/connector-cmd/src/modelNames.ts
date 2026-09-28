/**
 * A readable name for a Command Code model, derived from its id.
 *
 * `cmd --list-models` prints two columns, `<id>  <tagline>`, and no name. The
 * CLI's own catalogue does hold one (`google/gemini-3.5-flash` is "Gemini 3.5
 * Flash"), but it is never printed and lives only in a minified, self-updating
 * bundle, so the name is rebuilt from the id by the rules below. They match the
 * CLI's names on most rows of the recorded 1.66.0 table; where they differ it
 * is cosmetic ("FlashX" reads "Flashx"), never a tagline.
 */

/** Brand words whose casing no rule can guess. */
const BRAND_CASING: Readonly<Record<string, string>> = {
  gpt: "GPT",
  glm: "GLM",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  mimo: "MiMo",
  longcat: "LongCat",
};

/** Brands that keep a hyphen before their version: "GPT-5.4", "GLM-5.3". */
const HYPHENATED_BRANDS = new Set(["GPT", "GLM"]);

const VERSION = /^\d+(?:\.\d+)*$/;
const SHORT_NUMBER = /^\d{1,2}$/;

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** One `-`-separated segment → the word(s) it reads as. */
const casing = (segment: string): ReadonlyArray<string> => {
  const brand = BRAND_CASING[segment];
  if (brand !== undefined) {
    return [brand];
  }
  // A single letter glued to a version: v4, k2.5, m3, a55b.
  if (/^[a-z]\d[a-z0-9.]*$/.test(segment)) {
    return [segment.toUpperCase()];
  }
  // A parameter count: 27b, 550b.
  if (/^\d+b$/.test(segment)) {
    return [segment.toUpperCase()];
  }
  // A word glued to its version: qwen3.8 → Qwen 3.8.
  const glued = /^([a-z]{3,})(\d+(?:\.\d+)*)$/.exec(segment);
  if (glued !== null) {
    return [...casing(glued[1]!), glued[2]!];
  }
  return [capitalise(segment)];
};

export const modelNameFromId = (id: string): string => {
  // The provider is already the row's family.
  let base = (id.split("/").at(-1) ?? id).toLowerCase();
  const suffixes: Array<string> = [];
  const tag = /:([a-z0-9._-]+)$/.exec(base);
  if (tag !== null) {
    base = base.slice(0, tag.index);
  }
  const taggedFree = tag?.[1] === "free";
  const dashFree = base.endsWith("-free");
  if (dashFree) {
    base = base.slice(0, -"-free".length);
  }
  if (tag !== null && !taggedFree) {
    // Any other tag stays visible, so `x` and `x:tag` never share a name.
    suffixes.push(`(${capitalise(tag[1]!)})`);
  }
  if (taggedFree || dashFree) {
    // The CLI's own "LongCat 2.0 (Free)" — and the one visible cue that tells
    // `meituan/longcat-2.0` from `meituan/longcat-2.0:free`.
    suffixes.push("(Free)");
  }

  const segments = base.split("-").filter((segment) => segment !== "");
  // Adjacent short numbers are one version: claude-opus-4-8 → 4.8. Joined by
  // position, so claude-opus-5-5 reads 5.5 rather than "5 5".
  const joined: Array<string> = [];
  segments.forEach((segment, index) => {
    const previous = index > 0 ? segments[index - 1]! : undefined;
    if (
      previous !== undefined &&
      SHORT_NUMBER.test(segment) &&
      SHORT_NUMBER.test(previous) &&
      joined.length > 0
    ) {
      joined[joined.length - 1] = `${joined[joined.length - 1]}.${segment}`;
    } else {
      joined.push(segment);
    }
  });

  const words: Array<string> = [];
  for (const segment of joined.flatMap(casing)) {
    const previous = words.at(-1);
    if (previous !== undefined && HYPHENATED_BRANDS.has(previous) && VERSION.test(segment)) {
      words[words.length - 1] = `${previous}-${segment}`;
    } else {
      words.push(segment);
    }
  }

  const name = words.join(" ").trim();
  return name === "" ? id : [name, ...suffixes].join(" ");
};
