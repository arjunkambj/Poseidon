/**
 * The slug a thread's worktree branch and directory are named with.
 *
 * Free text in — a thread title, the first message — and a name git and every
 * filesystem accept out: lowercase ASCII letters, digits and single dashes,
 * never a leading or trailing dash, at most `BRANCH_SLUG_MAX` characters, cut
 * at a word boundary when there is one. Accents are folded to their base
 * letter rather than dropped (`café` → `cafe`). Text with nothing usable in it
 * becomes `thread`. The server's `Worktrees.ts` names the branch, the worktree
 * directory and the project's folder under the worktrees root with it.
 */

export const BRANCH_SLUG_MAX = 40;

const FALLBACK = "thread";

export const branchSlug = (text: string): string => {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (words.length <= BRANCH_SLUG_MAX) {
    return words === "" ? FALLBACK : words;
  }
  // One character past the limit: a dash there means the limit falls exactly
  // on a word boundary, and the whole first `BRANCH_SLUG_MAX` characters fit.
  const boundary = words.slice(0, BRANCH_SLUG_MAX + 1).lastIndexOf("-");
  const cut = boundary > 0 ? words.slice(0, boundary) : words.slice(0, BRANCH_SLUG_MAX);
  const slug = cut.replace(/-+$/g, "");
  return slug === "" ? FALLBACK : slug;
};
