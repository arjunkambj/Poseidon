/**
 * What the find bar marks in the rows on screen (`use-thread-find.ts`): the
 * query, and the row holding the current match. The list recycles rows and
 * renders them inside the timeline's tree, so a context reaches every row
 * without a prop through each row component.
 *
 * The value is `null` while the bar is closed or empty, and that is the only
 * value it holds then: a streamed delta leaves it as it is, so no row reading
 * it renders again, and `FindText` hands its text back untouched. Markdown is
 * marked by a rehype plugin (`rehype-find-marks.ts`) with the same classes.
 */

import * as React from "react";

import { FIND_MARK_CLASSES } from "./rehype-find-marks";
import { hasMatch, splitHighlights } from "./thread-find";

export interface FindHighlight {
  readonly query: string;
  /** The item holding the current match. */
  readonly activeItemId: string | undefined;
  /** The top-level row holding that item, which carries the ring. */
  readonly activeRowId: string | undefined;
}

const ThreadFindHighlightContext = React.createContext<FindHighlight | null>(null);

export function ThreadFindHighlightProvider({
  value,
  children,
}: {
  /** Memoised by the caller: every marked row rerenders when it changes. */
  value: FindHighlight | null;
  children: React.ReactNode;
}) {
  return (
    <ThreadFindHighlightContext.Provider value={value}>
      {children}
    </ThreadFindHighlightContext.Provider>
  );
}

export const useFindHighlight = (): FindHighlight | null =>
  React.useContext(ThreadFindHighlightContext);

const MARK_CLASS = FIND_MARK_CLASSES.join(" ");

/** Plain text with the query marked while the bar searches; the text as it is otherwise. */
export function FindText({ text }: { text: string }) {
  const highlight = useFindHighlight();
  if (highlight === null || !hasMatch(text, highlight.query)) {
    return text;
  }
  return splitHighlights(text, highlight.query).map((segment, index) =>
    segment.match ? (
      // Runs never move within one text, so their place is their key.
      <mark key={index} className={MARK_CLASS}>
        {segment.text}
      </mark>
    ) : (
      <React.Fragment key={index}>{segment.text}</React.Fragment>
    ),
  );
}

/**
 * Rings the row holding the current match. Every other row, and every row
 * while the bar is closed, renders with no element of its own, so the list
 * measures what it always does.
 */
export function FindRowMark({ rowId, children }: { rowId: string; children: React.ReactNode }) {
  const highlight = useFindHighlight();
  if (highlight === null || highlight.activeRowId !== rowId) {
    return children;
  }
  return (
    <div
      data-find-current
      className="rounded-lg ring-1 ring-ring ring-offset-4 ring-offset-background"
    >
      {children}
    </div>
  );
}
