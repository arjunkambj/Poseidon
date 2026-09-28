/**
 * What the command palette makes of its input. A leading ">" switches it to
 * commands only — the thread list steps aside — and the rest of the text is
 * what the entries are matched against, so "> set" finds the settings pages
 * rather than nothing with a ">" in it.
 */

import { defaultFilter } from "cmdk";

/**
 * The keyword a message-search hit carries. The server already matched the
 * hit's text, so the palette keeps it for any query rather than fuzzy-matching
 * its title against the query a second time.
 */
export const MESSAGE_HIT_KEYWORD = "palette-message-hit";

/**
 * A message hit's score: above zero, so it stays and counts as a result (the
 * "No results found" row keys off that count), and below any real fuzzy
 * match, so title hits rank first — cmdk orders its groups by their best item.
 */
const MESSAGE_HIT_SCORE = 1e-9;

export type PaletteQuery = {
  readonly commandsOnly: boolean;
  readonly query: string;
};

export function paletteQuery(search: string): PaletteQuery {
  const trimmed = search.trim();
  if (trimmed.startsWith(">")) {
    return { commandsOnly: true, query: trimmed.slice(1).trim() };
  }
  return { commandsOnly: false, query: trimmed };
}

/**
 * The palette's matcher: the stock fuzzy score, run against the query rather
 * than the raw input, so the ">" itself never has to match. It reads the query
 * from the text it is handed instead of closing over one, so it can never score
 * against a query from an earlier keystroke. A bare ">" has nothing left to
 * match, so every entry stays.
 */
export function paletteFilter(
  value: string,
  search: string,
  keywords?: ReadonlyArray<string>,
): number {
  const { query } = paletteQuery(search);
  if (query === "") {
    return 1;
  }
  if (keywords?.includes(MESSAGE_HIT_KEYWORD) === true) {
    return MESSAGE_HIT_SCORE;
  }
  return defaultFilter(value, query, keywords === undefined ? undefined : [...keywords]);
}

/**
 * The text the palette sends to message search: the query, once it is past
 * two characters and not a ">" command search. Null when nothing is asked.
 */
export function messageSearchQuery(search: string): string | null {
  const { commandsOnly, query } = paletteQuery(search);
  return commandsOnly || Array.from(query).length <= 2 ? null : query;
}
