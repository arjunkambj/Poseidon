/**
 * The sidebar's triage keys, which work from any route — mounted once by
 * `AppShortcuts`.
 *
 * - `thread.pin` pins the open thread, or unpins it when it is pinned.
 * - `sidebar.undo` undoes the latest sidebar action (`./sidebar-undo`). Its
 *   default chord is `Mod+Z`, bound only outside text fields, the terminal and
 *   the browser pane, so typing keeps its own undo.
 *
 * Each is claimed only while it has something to act on — an open thread, an
 * entry on the stack — so the palette never offers a row that does nothing.
 */

import { useMatchRoute } from "@tanstack/react-router";

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { useSidebarUndo } from "@/components/sidebar/sidebar-undo";
import { useThreadPins } from "@/components/sidebar/thread-pins";
import { useSidebarActions } from "@/components/sidebar/use-sidebar-actions";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useThreadList } from "@/state/hooks";

function PinShortcut({ thread }: { readonly thread: ThreadSummary }) {
  const actions = useSidebarActions();
  const [pins] = useThreadPins();
  useKeybindingCommand("thread.pin", () =>
    actions.setPinned(thread, !pins.includes(thread.threadId)),
  );
  return null;
}

function UndoShortcut({ undoLatest }: { readonly undoLatest: () => void }) {
  useKeybindingCommand("sidebar.undo", undoLatest);
  return null;
}

export function TriageShortcuts() {
  const openRoute = useMatchRoute()({ to: "/t/$threadId" });
  const openThreadId = openRoute === false ? null : openRoute.threadId;
  const thread = useThreadList().find((candidate) => candidate.threadId === openThreadId);
  const { canUndo, undoLatest } = useSidebarUndo();

  return (
    <>
      {thread === undefined || thread.status === "deleted" ? null : <PinShortcut thread={thread} />}
      {canUndo ? <UndoShortcut undoLatest={undoLatest} /> : null}
    </>
  );
}
