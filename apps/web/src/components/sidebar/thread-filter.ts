/**
 * The sidebar's title filter: what is typed in the field in the Projects
 * header (`./thread-filter-input`), and the rule a title matches it by.
 *
 * The query narrows every group the sidebar draws — pinned, each project,
 * "Other threads" — through `sidebarThreadGroups` (`./thread-order`), so the
 * thread keys walk only the rows left on screen. It matches titles only, not
 * message text, and it is not stored: a reload starts with the full list.
 *
 * `threads.filter` (palette only, no default chord) puts the focus in the
 * field. The sidebar may be folded away, or on a narrow window not mounted at
 * all, when the command fires, so it leaves a request here and the field takes
 * it when it mounts, or at once when it is already on screen — the same shape
 * as `@/lib/composer-focus`.
 */

import { useAtom } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";

/**
 * Whether `title` matches the filter: case-insensitive, the query trimmed.
 * An empty (or blank) query matches every title.
 */
export const matchesTitle = (title: string, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return needle === "" || title.toLowerCase().includes(needle);
};

/** Whether `query` filters anything at all. */
export const isFiltering = (query: string): boolean => query.trim() !== "";

// `keepAlive`: the sidebar's sheet unmounts on a narrow window, and the query
// should outlive that.
const threadFilterAtom = Atom.keepAlive(Atom.make(""));

/** `[query, setQuery]` — the text in the Projects header's filter field. */
export const useThreadFilter = () => useAtom(threadFilterAtom);

let pending = false;
const listeners = new Set<() => void>();

/** Ask the filter field to take the focus, now or when it mounts. */
export const requestFilterFocus = (): void => {
  pending = true;
  for (const listener of listeners) {
    listener();
  }
};

/** True, once, when a request is waiting; it is then spent. */
export const takeFilterFocus = (): boolean => {
  const waiting = pending;
  pending = false;
  return waiting;
};

/** Called on every request, so a mounted field can take one for itself. */
export const onFilterFocusRequest = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
