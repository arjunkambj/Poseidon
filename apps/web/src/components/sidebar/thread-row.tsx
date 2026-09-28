/**
 * One thread in the projects → threads tree, on the stock sidebar menu parts.
 *
 * Left to right: a fixed status slot, the title, a terminal mark while the
 * thread's own terminals run a shell (`../terminal/thread-terminals-mark`), a
 * fork mark when the thread works in its own worktree, and how long ago the
 * thread last moved. The slot holds the status mark from `./thread-status` —
 * needs you, plan ready, running, error — and, only when there is none, the
 * unread dot; a thread that is running or waiting says so louder than
 * "unread" can, and the title's weight still carries the unread emphasis.
 * The slot sits under the project's folder icon, so the title lines up with
 * the project name.
 *
 * A row that is only working — running, waiting on nobody, not the open
 * thread — recedes: a muted title, and how long the turn has been working in
 * place of when the thread last moved (`./working-time`).
 *
 * On hover the time fades and the overflow menu takes its place; a
 * right-click on the row opens that same menu. The time is a label, not a clock: `ProjectTree` owns the one
 * minute tick and passes `now` down, so a long list runs a single interval.
 *
 * Cmd/Ctrl-click and Shift-click pick rows instead of following the link —
 * left to the browser, they would open the app in a new window, which the
 * desktop shell hands to the OS browser. A middle click is kept in too. While
 * anything is picked, the picked rows carry the highlight rather than the open
 * thread — see `./thread-selection`.
 */

import { Link, useMatchRoute } from "@tanstack/react-router";
import * as React from "react";

import { SidebarMenuButton, SidebarMenuItem } from "@poseidon/ui/components/sidebar";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { ThreadContextMenu, ThreadRowMenu } from "@/components/sidebar/thread-menu";
import { isUnread, useThreadSeen } from "@/components/sidebar/thread-seen";
import { selectGestureOf, type SelectGesture } from "@/components/sidebar/thread-selection";
import { threadStatusMark } from "@/components/sidebar/thread-status";
import { recedes, workingLabel } from "@/components/sidebar/working-time";
import { ThreadTerminalsMark } from "@/components/terminal/thread-terminals-mark";
import { useThreadRunningTerminals } from "@/components/terminal/use-running-terminals";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { GitFork } from "@honeyicons/react";

const UNREAD_LABEL = "Updated since you last opened it";

function ThreadStatusSlot({ thread, unread }: { thread: ThreadSummary; unread: boolean }) {
  const mark = threadStatusMark(thread);
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {mark !== null ? (
        <span title={mark.label} aria-label={mark.label} role="img" className="flex">
          <mark.icon variant="bold" className={mark.tone} />
        </span>
      ) : unread ? (
        <span
          title={UNREAD_LABEL}
          aria-label={UNREAD_LABEL}
          role="img"
          className="size-1.5 rounded-full bg-primary"
        />
      ) : null}
    </span>
  );
}

export function ThreadRow({
  thread,
  now,
  selected,
  selecting,
  onSelect,
  onOpen,
}: {
  thread: ThreadSummary;
  now: number;
  /** Picked for a bulk action. */
  selected: boolean;
  /** Whether any row is picked; the open thread gives up its highlight then. */
  selecting: boolean;
  onSelect: (gesture: SelectGesture) => void;
  /** A plain click, which opens the thread and lets go of any selection. */
  onOpen: () => void;
}) {
  const matchRoute = useMatchRoute();
  const active = Boolean(matchRoute({ to: "/t/$threadId", params: { threadId: thread.threadId } }));
  const [seen, remember] = useThreadSeen();
  const { threadId, updatedAt } = thread;

  // The open thread is being read right now, so every event it takes is seen.
  React.useEffect(() => {
    if (active) {
      remember(threadId, updatedAt);
    }
  }, [active, threadId, updatedAt, remember]);

  const unread = !active && isUnread(seen, thread);
  const archived = thread.status === "archived";
  const receding = recedes(thread, active);
  const working = receding ? workingLabel(thread, now) : null;
  // "1h 4m" is wider than "3h", so the title keeps further from the corner.
  const clearTime = working === null ? "mr-6" : "mr-12";
  const terminals = useThreadRunningTerminals(threadId);
  // The last inline piece keeps clear of the corner: the fork mark, else the
  // terminal mark, else the title.
  const lastPiece =
    thread.worktree !== undefined ? "fork" : terminals.length > 0 ? "terminals" : "title";

  return (
    <ThreadContextMenu thread={thread} active={active} row={<SidebarMenuItem />}>
      <SidebarMenuButton
        size="sm"
        isActive={selecting ? selected : active}
        render={
          <Link
            to="/t/$threadId"
            params={{ threadId }}
            aria-current={active ? "page" : undefined}
            aria-selected={selecting ? selected : undefined}
            onClick={(event) => {
              const gesture = selectGestureOf(event);
              if (gesture === null) {
                onOpen();
                return;
              }
              // Also stops the router, which skips a prevented click.
              event.preventDefault();
              onSelect(gesture);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
              }
            }}
          />
        }
      >
        <ThreadStatusSlot thread={thread} unread={unread} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            // The time is pinned to the corner, so the last inline piece
            // keeps clear of the hover menu on its own.
            lastPiece === "title" && clearTime,
            // The highlight marks the open row; only unread changes the
            // weight, so the title and the time undo the active row's. A row
            // that is only working steps back, unread or not.
            receding
              ? "font-normal text-muted-foreground"
              : unread
                ? "font-medium text-foreground"
                : "font-normal",
            // Archiving is a real state change that the row otherwise showed
            // nothing for: `threadStatusMark` has no mark for it by design.
            // Only the open thread can be listed while archived.
            archived && "text-muted-foreground italic",
          )}
          title={archived ? `${thread.title} (archived)` : undefined}
        >
          {thread.title}
        </span>
        <ThreadTerminalsMark
          terminals={terminals}
          className={lastPiece === "terminals" ? clearTime : undefined}
        />
        {thread.worktree === undefined ? null : (
          <span
            title={`Worktree ${thread.worktree.branch}`}
            aria-label={`Worktree ${thread.worktree.branch}`}
            role="img"
            className={cn("flex shrink-0 text-muted-foreground", clearTime)}
          >
            <GitFork variant="bold" className="size-3.5" />
          </span>
        )}
        <time
          dateTime={working === null ? updatedAt : thread.runningSince}
          title={working === null ? new Date(updatedAt).toLocaleString() : `Working for ${working}`}
          className="absolute top-1/2 right-2 -translate-y-1/2 type-micro font-normal text-muted-foreground tabular-nums transition-opacity duration-150 ease-out group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 group-has-data-popup-open/menu-item:opacity-0 max-md:hidden"
        >
          {working ?? relativeTime(now, updatedAt)}
        </time>
      </SidebarMenuButton>
      {/* The overflow menu brings its own trigger button, so it rides in a
          plain slot revealed on hover like a stock action (on a narrow
          screen it stays shown and the time steps aside), plus
          a hold while its popup is open — base-ui moves focus into the
          portalled menu, so `focus-within` on this row is false the whole
          time it is. */}
      <span className="absolute top-0 right-0.5 flex transition-opacity duration-150 ease-out group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 has-data-popup-open:opacity-100 md:opacity-0">
        <ThreadRowMenu thread={thread} active={active} />
      </span>
    </ThreadContextMenu>
  );
}
