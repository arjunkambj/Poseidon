/**
 * Scrolls the timeline to an item another surface asked for
 * (`lib/timeline-reveal-request.ts`): the Agents tab does, for a subagent's
 * task row. Requests for the thread on screen are taken when the timeline
 * mounts, when it switches to another thread, and as soon as one is made.
 *
 * A request opens what hides the item — its turn fold, its work group, the
 * tasks above it (`locateItem`) — and hands the scroll to the reader the way
 * the turn rail does (`release`), so a held send anchor lets go. The all-open
 * projection is only built when a request comes in. An opened fold brings its
 * rows in on the next render, so the scroll waits until the target row is in
 * the list's rows.
 */

import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { onTimelineRevealRequest, takeTimelineReveal } from "@/lib/timeline-reveal-request";
import { useSetRowDisclosures } from "@/state/ui";

import { ALL_FOLDS_OPEN, type BuildTimelineOptions, buildTimeline } from "./fold";
import type { TimelineProjection } from "./fold";
import { prefersReducedMotion } from "./list-hold";
import { locateItem } from "./thread-find";

/** Where the item's row lands: a little above the middle. */
const REVEAL_VIEW_POSITION = 0.3;

export function useTimelineReveal({
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
}): void {
  const [pendingRow, setPendingRow] = React.useState<string | undefined>(undefined);
  const setDisclosures = useSetRowDisclosures();
  const threadId = snapshot.threadId;

  const reveal = (itemId: string) => {
    const allOpen = buildTimeline(snapshot.items, { ...options, isFoldOpen: ALL_FOLDS_OPEN });
    const located = locateItem(allOpen, projection, itemId);
    if (located === undefined) {
      return;
    }
    if (located.open.length > 0) {
      setDisclosures(located.open, true);
    }
    release();
    setPendingRow(located.rowId);
  };
  const revealRef = React.useRef(reveal);
  revealRef.current = reveal;

  // The timeline stays mounted across threads: a scroll still waiting on the
  // last thread is dropped. Declared before the claim below, so this cleanup
  // runs first and a request for the new thread survives it.
  React.useEffect(() => () => setPendingRow(undefined), [threadId]);

  React.useEffect(() => {
    const claim = () => {
      const request = takeTimelineReveal(threadId);
      if (request !== null) {
        revealRef.current(request.itemId);
      }
    };
    claim();
    return onTimelineRevealRequest(claim);
  }, [threadId]);

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
      viewPosition: REVEAL_VIEW_POSITION,
      animated: !prefersReducedMotion(),
    });
  }, [pendingRow, rows, listRef]);
}
