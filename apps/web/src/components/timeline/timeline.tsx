/**
 * The virtualized thread timeline: `ItemSnapshot[]` from the detail atom,
 * folded by `buildTimeline`, rendered through `LegendList`. Row state that
 * must survive recycling (disclosure) lives in atoms, not component state.
 *
 * The timeline answers its own keys while it is on screen:
 * `timeline.jumpToLatest` scrolls to the end the way the jump button does, and
 * `timeline.collapseAll` / `expandAll` write a disclosure override for every
 * row that folds (`disclosureIds`), nested and grouped rows included. The ids
 * come from the projection with every turn fold open, so the rows a closed
 * fold hides are opened or closed along with it. Most of those folds are
 * above the viewport, so the send anchor is told first (`beforeFoldAll`) and
 * keeps the reader's place rather than handing them the scroll.
 *
 * A turn fold changes which rows the list holds, so the projection depends on
 * the open folds (`useOpenTurnFolds`) as well as on the snapshot.
 *
 * `useSendAnchor` decides who owns the scroll: it follows the end, holds a
 * just-sent message near the top while its reply streams in, or leaves the
 * reader alone once they scroll or open a turn fold, whose rows then open in
 * place instead of pushing the toggle up (`send-anchor.ts`). The turn rail and the
 * previous/next message keys (`turn-rail-view.tsx`) hand the scroll to the
 * reader the same way before they move it.
 *
 * The list is keyed by thread, so leaving a thread unmounts it and entering
 * one mounts it afresh: that is where the reader's place is saved and put
 * back (`use-reading-position.ts`). A thread left away from its end reopens
 * at the same row, free rather than following; one left at its end opens
 * there and follows.
 *
 * The Agents tab asks for a subagent's task row (`use-timeline-reveal.ts`).
 */

import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import { uuidV7Millis } from "@poseidon/shared/ids";
import { cn } from "@poseidon/ui/lib/utils";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { disclosureIds } from "@/components/timeline/disclosure";
import { ALL_FOLDS_OPEN, buildTimeline } from "@/components/timeline/fold";
import { JumpToLatest } from "@/components/timeline/jump-to-latest";
import { type TimelineThread, TimelineThreadProvider } from "@/components/timeline/thread-context";
import { ThreadFindBar } from "@/components/timeline/thread-find-bar";
import {
  type FindHighlight,
  FindRowMark,
  ThreadFindHighlightProvider,
} from "@/components/timeline/thread-find-context";
import { TimelineRowView } from "@/components/timeline/timeline-item";
import { turnEndTimes } from "@/components/timeline/turn-checkpoints";
import { TurnRail, useTurnNavigation } from "@/components/timeline/turn-rail-view";
import { useReadingPosition, useRestorePlace } from "@/components/timeline/use-reading-position";
import { useSendAnchor } from "@/components/timeline/use-send-anchor";
import { useThreadFind } from "@/components/timeline/use-thread-find";
import { useTimelineReveal } from "@/components/timeline/use-timeline-reveal";
import { useTimelineThreadValue } from "@/components/timeline/use-timeline-thread";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useChatWidth } from "@/lib/use-chat-width";
import { turnInFlight } from "@/lib/turn";
import { useOpenTurnFolds } from "@/state/turn-folds";
import { useSetRowDisclosures } from "@/state/ui";

export function Timeline({ snapshot }: { snapshot: ThreadDetailSnapshot }) {
  return <ThreadTimeline key={snapshot.threadId} snapshot={snapshot} />;
}

function ThreadTimeline({ snapshot }: { snapshot: ThreadDetailSnapshot }) {
  const listRef = React.useRef<LegendListRef>(null);
  const chatWidth = useChatWidth();
  const openFolds = useOpenTurnFolds();
  const turnEndedAt = React.useMemo(
    () => turnEndTimes(snapshot.checkpoints),
    [snapshot.checkpoints],
  );
  const options = React.useMemo(
    () => ({
      turnActive: turnInFlight(snapshot),
      turnStartedAt:
        snapshot.currentTurnId === null ? undefined : uuidV7Millis(snapshot.currentTurnId),
      decisions: snapshot.decisions,
      checkpoints: snapshot.checkpoints,
      turnEndedAt,
    }),
    [snapshot, turnEndedAt],
  );
  const projection = React.useMemo(
    () =>
      buildTimeline(snapshot.items, { ...options, isFoldOpen: (rowId) => openFolds.has(rowId) }),
    [snapshot.items, options, openFolds],
  );
  const everyDisclosure = () =>
    disclosureIds(buildTimeline(snapshot.items, { ...options, isFoldOpen: ALL_FOLDS_OPEN }));

  const thread = useTimelineThreadValue(snapshot);
  const restore = useRestorePlace(snapshot.threadId, projection.rows);
  const anchor = useSendAnchor({
    listRef,
    rows: projection.rows,
    openFolds,
    threadId: snapshot.threadId,
    turnActive: options.turnActive,
    startFree: restore !== undefined,
  });
  useReadingPosition({
    listRef,
    threadId: snapshot.threadId,
    restore,
    mode: anchor.mode,
    keepPlace: anchor.keepPlace,
  });
  const navigation = useTurnNavigation({ listRef, rows: projection.rows, release: anchor.release });
  const find = useThreadFind({ snapshot, options, projection, listRef, release: anchor.release });
  useTimelineReveal({ snapshot, options, projection, listRef, release: anchor.release });
  const setDisclosures = useSetRowDisclosures();
  useKeybindingCommand("timeline.jumpToLatest", anchor.jumpToLatest);
  // Folds above the viewport open and close too: the anchor holds the reader's place.
  const foldAll = (open: boolean) => {
    anchor.beforeFoldAll();
    setDisclosures(everyDisclosure(), open);
  };
  useKeybindingCommand("timeline.collapseAll", () => foldAll(false));
  useKeybindingCommand("timeline.expandAll", () => foldAll(true));

  const renderItem = React.useCallback(
    ({ item }: { item: (typeof projection.rows)[number] }) => (
      <FindRowMark rowId={item.id}>
        <TimelineRowView row={item} childrenByParent={projection.childrenByParent} />
      </FindRowMark>
    ),
    [projection],
  );

  return (
    <TimelineScope thread={thread} highlight={find.highlight}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <LegendList
          ref={listRef}
          data={projection.rows}
          keyExtractor={(row) => row.id}
          getItemType={(row) => (row.kind === "item" ? row.item.kind : row.kind)}
          renderItem={renderItem}
          estimatedItemSize={40}
          drawDistance={500}
          recycleItems
          initialScrollAtEnd={restore === undefined}
          initialScrollIndex={
            restore === undefined ? undefined : { index: restore.index, viewOffset: restore.offset }
          }
          maintainScrollAtEnd={anchor.maintainScrollAtEnd}
          anchoredEndSpace={anchor.anchoredEndSpace}
          extraData={projection.childrenByParent}
          className="min-h-0 flex-1"
          // The row gap has to be a value, not a class: the virtualizer measures
          // rows itself and a Tailwind `gap-*` it cannot read throws off
          // `estimatedItemSize`, the draw distance and the scroll anchoring — which
          // is what left blank stretches mid-scroll. LegendList warns about it too.
          // The vertical padding is a value for the same reason: scroll-to-end
          // aims at the end it computes, and a `py-*` it cannot see left the
          // last row — the working clock, the turn summary — under the fold.
          contentContainerClassName={cn(
            "mx-auto flex w-full flex-col px-6",
            chatWidth.classes.timeline,
          )}
          contentContainerStyle={{ gap: 16, paddingTop: 24, paddingBottom: 24 }}
        />
        <JumpToLatest
          listRef={listRef}
          activity={snapshot.items}
          hidden={anchor.placing}
          opensAway={restore !== undefined}
          onJump={anchor.jumpToLatest}
        />
        <TurnRail listRef={listRef} navigation={navigation} />
        {find.open ? <ThreadFindBar find={find} /> : null}
      </div>
    </TimelineScope>
  );
}

/** What every row reads: the thread it belongs to, and what the find bar marks. */
function TimelineScope({
  thread,
  highlight,
  children,
}: {
  thread: TimelineThread;
  highlight: FindHighlight | null;
  children: React.ReactNode;
}) {
  return (
    <TimelineThreadProvider value={thread}>
      <ThreadFindHighlightProvider value={highlight}>{children}</ThreadFindHighlightProvider>
    </TimelineThreadProvider>
  );
}
