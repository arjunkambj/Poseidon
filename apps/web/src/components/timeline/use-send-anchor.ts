/**
 * Feeds `sendAnchorReducer` from the timeline and turns its state into what
 * `LegendList` takes: `maintainScrollAtEnd`, and `anchoredEndSpace` on the
 * last sent message so it can reach the top of the viewport.
 *
 * On a send the message is scrolled to `ANCHOR_OFFSET` below the top — eased
 * unless the reader asked for reduced motion — and then held. Rows above it
 * settle from estimated to measured heights for a few hundred milliseconds
 * after a send, and the reserve under it catches up a frame late, so one
 * scroll would land wrong: the hold re-places the row without animation on
 * every frame the geometry moves, until it has been still for `HOLD_QUIET_MS`.
 * When the turn settles the rows under the message shrink, and it is held
 * again from that render's layout effect, before paint and without easing
 * (`holdSettledAnchor`).
 *
 * The reader takes the scroll back with any wheel, touch drag, scrolling key
 * in the list, press on its scrollbar, or text selection inside it. The
 * list's own scrolls are not events here, so the hold never releases itself.
 * The intent stops the hold on the spot, before the dispatch: a wheel's
 * render is not urgent, and a frame of the hold between the reader's scroll
 * and that render would read the scroll as the list moving and put the
 * message back, undoing the reader's first tick.
 *
 * Expand-all and collapse-all go through `beforeFoldAll`: the list's own
 * data-change scroll anchoring is off, so rows opening or closing above the
 * viewport would move what the reader sees. Unless the list follows at its
 * end, the row they were on is held where it sat (`keepInView`), the same way
 * the send hold does, and the reader's scroll stops that hold too.
 *
 * A thread reopened at the reader's saved place starts free (`startFree`), and
 * `keepPlace` holds the saved row where it sat while the rows settle, in the
 * same slot as the bulk fold hold: the reader's first scroll lets go of it,
 * and reaching the end follows again.
 */

import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { sentHereRecently } from "@/state/local-sends";

import type { TimelineRow } from "./fold";
import {
  ANCHOR_OFFSET,
  currentViewAnchors,
  holdSettledAnchor,
  keepInView,
  placeAnchor,
  prefersReducedMotion,
  scrollsList,
} from "./list-hold";
import {
  bulkFoldKeepsEnd,
  foldsOpened,
  INITIAL_SEND_ANCHOR,
  initialSendAnchor,
  rowIdSet,
  sendAnchorProps,
  sendAnchorReducer,
  sentUserMessageId,
  type SendAnchorEvent,
  type SendAnchorMode,
  type SendAnchorState,
  type ViewAnchor,
} from "./send-anchor";

type Action = SendAnchorEvent | { readonly type: "reset" };

const reduce = (state: SendAnchorState, action: Action): SendAnchorState =>
  action.type === "reset" ? INITIAL_SEND_ANCHOR : sendAnchorReducer(state, action);

export interface SendAnchor {
  readonly maintainScrollAtEnd: boolean;
  readonly anchoredEndSpace:
    | {
        readonly anchorIndex: number;
        readonly anchorOffset: number;
        readonly onReady: (info: { anchorKey: string | undefined }) => void;
      }
    | undefined;
  /** A sent message is on its way to the top: the list is briefly away from its end. */
  readonly placing: boolean;
  /** Scroll to the end and follow again: the jump button and `timeline.jumpToLatest`. */
  readonly jumpToLatest: () => void;
  /** Hand the scroll to the reader, as their own scroll would: the turn rail and its keys. */
  readonly release: () => void;
  /** Call right before expand-all or collapse-all writes the folds. */
  readonly beforeFoldAll: () => void;
  /** Hold a row where it sat until the rows settle or the reader scrolls: a restored place. */
  readonly keepPlace: (anchor: ViewAnchor) => void;
  /** Who owns the scroll now. */
  readonly mode: SendAnchorMode;
}

export function useSendAnchor({
  listRef,
  rows,
  openFolds,
  threadId,
  turnActive,
  startFree = false,
}: {
  listRef: React.RefObject<LegendListRef | null>;
  rows: ReadonlyArray<TimelineRow>;
  /** The open turn folds the rows were built with. */
  openFolds: ReadonlySet<string>;
  threadId: string;
  turnActive: boolean;
  /** The list opens at a saved place rather than its end: do not follow from the first render. */
  startFree?: boolean;
}): SendAnchor {
  const [state, dispatch] = React.useReducer(reduce, startFree, initialSendAnchor);
  const modeRef = React.useRef(state.mode);
  modeRef.current = state.mode;
  // Expand-all or collapse-all on its way: the folds it was taken against, and
  // the rows to hold in view, or null when the list follows its end.
  const bulkFolds = React.useRef<{
    readonly from: ReadonlySet<string>;
    readonly anchors: ReadonlyArray<ViewAnchor> | null;
  } | null>(null);
  // A fold that opens hands the scroll to the reader in the same render that
  // brings its rows, before the list sees them with `maintainScrollAtEnd`
  // still on and scrolls them up past the toggle. Expand-all is not the
  // reader opening one fold under their eyes, and keeps the mode.
  const [seenFolds, setSeenFolds] = React.useState(openFolds);
  if (seenFolds !== openFolds) {
    setSeenFolds(openFolds);
    if (bulkFolds.current?.from !== seenFolds && foldsOpened(seenFolds, openFolds)) {
      dispatch({ type: "rowsOpened" });
    }
  }
  const props = sendAnchorProps(state);
  const anchorRowRef = React.useRef(props.anchorRowId);
  anchorRowRef.current = props.anchorRowId;
  // Cancel the placement running now, and a bulk fold change's hold, if any;
  // called before a release is dispatched.
  const stopPlacement = React.useRef<() => void>(() => {});
  const stopKeep = React.useRef<() => void>(() => {});
  const stopHold = React.useRef(() => {
    stopPlacement.current();
    stopKeep.current();
  });

  // Rows seen so far; null until the first projection of this thread.
  const seen = React.useRef<{ threadId: string; ids: ReadonlySet<string> } | null>(null);
  const wasActive = React.useRef(turnActive);
  // A layout effect, so the reserve and the follow flag change before paint.
  React.useLayoutEffect(() => {
    if (seen.current !== null && seen.current.threadId !== threadId) {
      seen.current = null;
      dispatch({ type: "reset" });
    }
    const newUserMessageId = sentUserMessageId(seen.current?.ids ?? null, rows) ?? undefined;
    seen.current = { threadId, ids: rowIdSet(rows) };
    dispatch({
      type: "rowsChanged",
      newUserMessageId,
      turnActive,
      sentHere: newUserMessageId !== undefined && sentHereRecently(threadId),
      // Read after the list took the new rows: at its end it has followed
      // them, away from it the flag is where the reader left it.
      awayFromEnd:
        newUserMessageId !== undefined && listRef.current?.getState().isNearEnd === false,
    });
    // The turn settled under the anchored message: its work folds away and
    // the rows under it shrink. Put it back before paint rather than easing.
    const list = listRef.current;
    const held = anchorRowRef.current;
    if (wasActive.current && !turnActive && held !== null && list !== null) {
      stopKeep.current();
      stopKeep.current = holdSettledAnchor(list, held);
    }
    wasActive.current = turnActive;
  }, [listRef, rows, threadId, turnActive]);

  // The reader's own scrolling, and the list reaching its end.
  React.useEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const node = list.getScrollableNode();
    const intent = () => {
      stopHold.current();
      dispatch({ type: "userScrollIntent" });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (scrollsList(event, node)) {
        intent();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      // Only a press on the scrollbar, which sits outside the client box.
      if (event.target === node && event.offsetX >= node.clientWidth) {
        intent();
      }
    };
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed && node.contains(selection.focusNode)) {
        intent();
      }
    };
    node.addEventListener("wheel", intent, { passive: true });
    node.addEventListener("touchmove", intent, { passive: true });
    node.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("selectionchange", onSelectionChange);
    const stopListening = list.getState().listen("isAtEnd", (atEnd) => {
      if (atEnd) {
        dispatch({ type: "reachedEnd" });
      }
    });
    return () => {
      node.removeEventListener("wheel", intent);
      node.removeEventListener("touchmove", intent);
      node.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("selectionchange", onSelectionChange);
      stopListening();
    };
  }, [listRef]);

  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  // The row whose reserve the list last reported measured, and who waits on it.
  const reserved = React.useRef<{ key: string | undefined; waiters: Set<() => void> }>({
    key: undefined,
    waiters: new Set(),
  });
  const onReserveReady = React.useCallback((info: { anchorKey: string | undefined }) => {
    reserved.current.key = info.anchorKey;
    for (const waiter of reserved.current.waiters) {
      waiter();
    }
  }, []);

  const anchorRowId = props.anchorRowId;
  const [placed, setPlaced] = React.useState(INITIAL_SEND_ANCHOR.placement);
  const placement = state.placement;
  // Place the anchored row, then hold it until the list stops moving under it.
  React.useEffect(() => {
    const list = listRef.current;
    if (anchorRowId === null || list === null) {
      return;
    }
    const cancel = placeAnchor({
      list,
      rowId: anchorRowId,
      indexOf: (rowId) => rowsRef.current.findIndex((row) => row.id === rowId),
      reserved: reserved.current,
      onPlaced: () => setPlaced(placement),
    });
    stopPlacement.current = cancel;
    return () => {
      cancel();
      if (stopPlacement.current === cancel) {
        stopPlacement.current = () => {};
      }
    };
  }, [listRef, anchorRowId, placement]);

  const openFoldsRef = React.useRef(openFolds);
  openFoldsRef.current = openFolds;
  const beforeFoldAll = React.useCallback(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const keepsEnd = bulkFoldKeepsEnd(
      modeRef.current,
      list.getState().isWithinMaintainScrollAtEndThreshold,
    );
    const pending = {
      from: openFoldsRef.current,
      anchors: keepsEnd ? null : currentViewAnchors(list),
    };
    bulkFolds.current = pending;
    // Every fold already as asked: nothing renders, and a later toggle of the
    // reader's own must not pass for this.
    requestAnimationFrame(() => {
      if (bulkFolds.current === pending) {
        bulkFolds.current = null;
      }
    });
  }, [listRef]);
  // After the list took the rows the bulk change brought or removed, and
  // before paint, put the reader's row back where it sat.
  React.useLayoutEffect(() => {
    const pending = bulkFolds.current;
    const list = listRef.current;
    if (pending === null || pending.from === openFolds) {
      return;
    }
    bulkFolds.current = null;
    if (pending.anchors === null || list === null) {
      return;
    }
    stopKeep.current();
    stopKeep.current = keepInView(list, pending.anchors);
  }, [listRef, openFolds]);
  React.useEffect(() => () => stopKeep.current(), []);
  const keepPlace = React.useCallback(
    (anchor: ViewAnchor) => {
      const list = listRef.current;
      if (list === null) {
        return;
      }
      stopKeep.current();
      stopKeep.current = keepInView(list, [anchor]);
    },
    [listRef],
  );

  const reserveIndex =
    props.reserveRowId === null ? -1 : rows.findIndex((row) => row.id === props.reserveRowId);
  const jumpToLatest = React.useCallback(() => {
    dispatch({ type: "jumpToLatest" });
    void listRef.current?.scrollToEnd({ animated: !prefersReducedMotion() });
  }, [listRef]);
  const release = React.useCallback(() => {
    stopHold.current();
    dispatch({ type: "userScrollIntent" });
  }, []);

  return {
    maintainScrollAtEnd: props.maintainScrollAtEnd,
    anchoredEndSpace:
      reserveIndex < 0
        ? undefined
        : { anchorIndex: reserveIndex, anchorOffset: ANCHOR_OFFSET, onReady: onReserveReady },
    placing: anchorRowId !== null && placed !== placement,
    jumpToLatest,
    release,
    beforeFoldAll,
    keepPlace,
    mode: state.mode,
  };
}
