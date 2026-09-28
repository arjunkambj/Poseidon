/**
 * The two letters a harness avatar shows. The repo ships no harness logos, so
 * every harness is drawn as a monogram of its instance's display name.
 *
 * A name's natural monogram is the initials of its first two words ("Comet
 * Cloud" → "CC"), or for a one-word name its first two letters ("Corvid" →
 * "Co"). Names can collide — "Comet Cloud" and "Cedar Cove" are both "CC" —
 * so each name has a ladder of candidates:
 *
 *   1. the natural monogram;
 *   2. the first two letters of the first word ("Co", "Ce");
 *   3. the first and last letters of the first word ("Ct", "Cr", "Cd").
 *
 * Every name starts on its first rung. While some monogram is shared, every
 * name sharing it steps one rung down — no name wins a tie, so the result does
 * not depend on the order the names come in. A name out of rungs is its first
 * letter and its 1-based position in the list.
 */

const words = (name: string): ReadonlyArray<string> =>
  name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);

const upper = (letter: string | undefined) => (letter ?? "").toLocaleUpperCase();
const lower = (letter: string | undefined) => (letter ?? "").toLocaleLowerCase();

/** A name's candidates, best first, without repeats. */
const ladder = (name: string): ReadonlyArray<string> => {
  const [first = "", second] = words(name);
  const letters = Array.from(first);
  const firstTwo = upper(letters[0]) + lower(letters[1]);
  const firstLast = letters.length > 1 ? upper(letters[0]) + lower(letters.at(-1)) : "";
  const natural =
    second === undefined ? firstTwo : upper(letters[0]) + upper(Array.from(second)[0]);
  return [natural, firstTwo, firstLast].filter(
    (candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index,
  );
};

/** One monogram per name, in the same order, no two alike. */
export const harnessMonograms = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const ladders = names.map((name, index) => [
    ...ladder(name),
    `${upper(Array.from(name)[0]) || "?"}${index + 1}`,
  ]);
  const rungs = names.map(() => 0);
  for (;;) {
    const current = ladders.map((candidates, index) => candidates[rungs[index] ?? 0] ?? "");
    const shared = new Set(current.filter((mono, index) => current.indexOf(mono) !== index));
    let stepped = false;
    current.forEach((mono, index) => {
      const rung = rungs[index] ?? 0;
      if (shared.has(mono) && rung < (ladders[index]?.length ?? 0) - 1) {
        rungs[index] = rung + 1;
        stepped = true;
      }
    });
    // Nothing shared, or only positional fallbacks left (which a name could
    // only tie with by spelling a letter and a digit itself).
    if (!stepped) {
      return current;
    }
  }
};
