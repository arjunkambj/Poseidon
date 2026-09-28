/**
 * Keeps the reader's place in one thread's timeline across visits, for the
 * session: the rules are `reading-position.ts`, the store
 * `state/timeline-positions.ts`.
 *
 * The timeline mounts once per thread, so a mount is a visit. It reads the
 * saved place once, as it mounts, without subscribing: the only writer is
 * this hook's own unmount. While mounted, the rows on screen and whether the
 * list sits at its end are noted once a frame as the list scrolls, and on the
 * way out that note is what gets saved. The cleanup measures nothing — the
 * list may already be detached from the page by then, and would read as
 * scrolled to the top.
 *
 * The restore itself is the list's `initialScrollIndex`, so the first paint
 * is already at the saved row, and then the send anchor's `keepPlace`, from a
 * layout effect before that paint, which holds the row where it sat while
 * the rows around it settle from estimated to measured heights.
 */

import { RegistryContext } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { timelinePositionsAtom, withTimelinePosition } from "@/state/timeline-positions";

import type { TimelineRow } from "./fold";
import { currentViewAnchors } from "./list-hold";
import { positionToSave, restoreTarget } from "./reading-position";
import type { SendAnchorMode, ViewAnchor } from "./send-anchor";

/** A saved place the list reopens at: the row's index in the first projection, and where it sat. */
export interface RestorePlace extends ViewAnchor {
  readonly index: number;
}

/** The saved place of `threadId`, if its row is still there; read once, at mount. */
export function useRestorePlace(
  threadId: string,
  rows: ReadonlyArray<TimelineRow>,
): RestorePlace | undefined {
  const registry = React.useContext(RegistryContext);
  const [place] = React.useState(() => {
    const target = restoreTarget(rows, registry.get(timelinePositionsAtom)[threadId]);
    const row = target === undefined ? undefined : rows[target.index];
    return target === undefined || row === undefined
      ? undefined
      : { index: target.index, rowId: row.id, offset: target.offset };
  });
  return place;
}

/** What was last seen of the list: whether it sat at its end, and its first row on screen. */
interface Seen {
  readonly atEnd: boolean;
  readonly top: ViewAnchor | undefined;
}

/**
 * Put the list back at `restore` before the first paint, and save where the
 * reader is when the timeline unmounts.
 */
export function useReadingPosition({
  listRef,
  threadId,
  restore,
  mode,
  keepPlace,
}: {
  listRef: React.RefObject<LegendListRef | null>;
  threadId: string;
  restore: RestorePlace | undefined;
  mode: SendAnchorMode;
  keepPlace: (anchor: ViewAnchor) => void;
}): void {
  const registry = React.useContext(RegistryContext);
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  // Until the list scrolls, it is where it opened.
  const seen = React.useRef<Seen>(
    restore === undefined
      ? { atEnd: true, top: undefined }
      : { atEnd: false, top: { rowId: restore.rowId, offset: restore.offset } },
  );

  React.useLayoutEffect(() => {
    if (restore !== undefined) {
      keepPlace({ rowId: restore.rowId, offset: restore.offset });
    }
  }, [restore, keepPlace]);

  React.useEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const node = list.getScrollableNode();
    let frame = 0;
    const note = () => {
      frame = 0;
      const state = list.getState();
      seen.current = {
        atEnd: state.isAtEnd || state.isWithinMaintainScrollAtEndThreshold,
        top: currentViewAnchors(list)[0],
      };
    };
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(note);
      }
    };
    node.addEventListener("scroll", schedule, { passive: true });
    const stopListening = list.getState().listen("isAtEnd", schedule);
    return () => {
      node.removeEventListener("scroll", schedule);
      stopListening();
      cancelAnimationFrame(frame);
      const { atEnd, top } = seen.current;
      const position = positionToSave({
        atEnd,
        mode: modeRef.current,
        anchors: top === undefined ? [] : [top],
      });
      registry.set(
        timelinePositionsAtom,
        withTimelinePosition(registry.get(timelinePositionsAtom), threadId, position),
      );
    };
  }, [listRef, registry, threadId]);
}
