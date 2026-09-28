/**
 * Find in thread: the state behind the find bar (`thread-find-bar.tsx`) and
 * the scroll it drives. `timeline.find` opens the bar, or puts the focus back
 * in it and selects the query when it is already open.
 *
 * The bar is closed nearly all the time and the timeline rerenders on every
 * streamed delta, so a closed bar costs nothing: the all-open projection, the
 * documents and the matches are only built while the bar is open with a
 * query. While it is open they are built from a deferred copy of the items,
 * so a streamed delta renders first and the search catches up after it.
 *
 * Typing is debounced; a new query goes to its first match. Stepping picks the
 * next or previous match, opens what hides it — its turn fold, its work group,
 * the tasks above it, its own body (`locateItem`) — and hands the scroll to
 * the reader the way the turn rail does (`release`), so a held send anchor
 * lets go. An opened fold brings its rows in on the next render, so the
 * scroll waits until the target row is in the list's rows.
 *
 * Closing the bar clears it and puts the focus back in the composer.
 */

import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { requestComposerFocus } from "@/lib/composer-focus";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useSetRowDisclosures } from "@/state/ui";

import { ALL_FOLDS_OPEN, type BuildTimelineOptions, buildTimeline } from "./fold";
import type { TimelineProjection } from "./fold";
import { prefersReducedMotion } from "./list-hold";
import {
  currentMatchIndex,
  type FindMatch,
  type FindSelection,
  findDocuments,
  findMatches,
  locateItem,
  normalizeQuery,
  stepMatch,
} from "./thread-find";

/** How long typing has to pause before the thread is searched, in ms. */
const FIND_DEBOUNCE_MS = 150;

/** Where a match's row lands: a little above the middle, clear of the bar. */
const FIND_VIEW_POSITION = 0.3;

const NO_MATCHES: ReadonlyArray<FindMatch> = [];

/** What the rows mark while the bar is open with a query; null otherwise. */
export interface FindHighlight {
  readonly query: string;
  readonly activeItemId: string | undefined;
}

export interface ThreadFind {
  readonly open: boolean;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  /** Whether the debounced query searches anything, so a count means something. */
  readonly searching: boolean;
  readonly count: number;
  /** The current match, or -1 without one. */
  readonly index: number;
  readonly step: (direction: "next" | "previous") => void;
  readonly close: () => void;
  /** Bumped by `timeline.find` while open, for the bar to refocus its input. */
  readonly focusKey: number;
  readonly highlight: FindHighlight | null;
}

export function useThreadFind({
  snapshot,
  options,
  projection,
  listRef,
  release,
}: {
  snapshot: ThreadDetailSnapshot;
  /** The options the timeline builds its projection with, less the open folds. */
  options: BuildTimelineOptions;
  /** The projection on screen, built with the folds as they are. */
  projection: TimelineProjection;
  listRef: React.RefObject<LegendListRef | null>;
  /** Hand the scroll to the reader, as their own scroll would. */
  release: () => void;
}): ThreadFind {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [selected, setSelected] = React.useState<FindSelection | undefined>(undefined);
  const [focusKey, setFocusKey] = React.useState(0);
  const [pendingRow, setPendingRow] = React.useState<string | undefined>(undefined);
  // A new query waits for its matches, then goes to the first one.
  const revealFirst = React.useRef(false);
  const setDisclosures = useSetRowDisclosures();
  const threadId = snapshot.threadId;

  const reset = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setDebouncedQuery("");
    setSelected(undefined);
    setPendingRow(undefined);
    revealFirst.current = false;
  }, []);
  // The timeline stays mounted across threads: another thread starts closed.
  React.useEffect(() => reset, [threadId, reset]);

  useKeybindingCommand("timeline.find", () => {
    setOpen(true);
    setFocusKey((key) => key + 1);
  });

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      setSelected(undefined);
      revealFirst.current = true;
    }, FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query]);

  const searching = open && normalizeQuery(debouncedQuery) !== undefined;
  // A constant while closed, so deferring it schedules nothing.
  const source = React.useMemo(
    () => (searching ? { items: snapshot.items, options } : null),
    [searching, snapshot.items, options],
  );
  const deferred = React.useDeferredValue(source);
  const allOpen = React.useMemo(
    () =>
      deferred === null
        ? undefined
        : buildTimeline(deferred.items, { ...deferred.options, isFoldOpen: ALL_FOLDS_OPEN }),
    [deferred],
  );
  const matches = React.useMemo(
    () =>
      allOpen === undefined || !searching
        ? NO_MATCHES
        : findMatches(findDocuments(allOpen), debouncedQuery),
    [allOpen, searching, debouncedQuery],
  );
  const index = currentMatchIndex(matches, selected);

  const goTo = (next: number) => {
    const match = matches[next];
    if (match === undefined || allOpen === undefined) {
      return;
    }
    setSelected({ match, index: next });
    const located = locateItem(allOpen, projection, match.itemId, match.field);
    if (located === undefined) {
      return;
    }
    if (located.open.length > 0) {
      setDisclosures(located.open, true);
    }
    release();
    setPendingRow(located.rowId);
  };
  const goToRef = React.useRef(goTo);
  goToRef.current = goTo;

  React.useEffect(() => {
    if (revealFirst.current && matches.length > 0) {
      revealFirst.current = false;
      goToRef.current(0);
    }
  }, [matches]);

  // Scroll once the target row is in the list: an opened fold brings it in a render later.
  const rows = projection.rows;
  React.useEffect(() => {
    if (pendingRow === undefined) {
      return;
    }
    const rowIndex = rows.findIndex((row) => row.id === pendingRow);
    if (rowIndex === -1) {
      return;
    }
    setPendingRow(undefined);
    void listRef.current?.scrollToIndex({
      index: rowIndex,
      viewPosition: FIND_VIEW_POSITION,
      animated: !prefersReducedMotion(),
    });
  }, [pendingRow, rows, listRef]);

  const step = (direction: "next" | "previous") => {
    if (matches.length > 0) {
      goTo(stepMatch(matches.length, index, direction));
    }
  };
  const close = () => {
    reset();
    requestComposerFocus(threadId);
  };

  const activeItemId = matches[index]?.itemId;
  const highlight = React.useMemo(
    () => (searching ? { query: debouncedQuery, activeItemId } : null),
    [searching, debouncedQuery, activeItemId],
  );

  return {
    open,
    query,
    setQuery,
    searching,
    count: matches.length,
    index,
    step,
    close,
    focusKey,
    highlight,
  };
}
