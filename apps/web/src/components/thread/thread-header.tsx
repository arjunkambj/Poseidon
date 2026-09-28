/**
 * The thread's slim header: a breadcrumb of its project and title, the
 * branch picker, the git actions, the agent-browser indicator, its status
 * and the terminal and dock toggles.
 *
 * The branch picker (`components/git/branch-picker.tsx`) sits beside the
 * title: the branch the thread's workspace is on, switchable for a local
 * thread, and marked as a worktree — with the directory in its tooltip — for
 * a thread that has one, because the agent's edits land there and not in the
 * project's folder. The header is where that stays in view once the thread
 * has messages and the greeting is gone.
 *
 * The git actions control (`components/git/git-actions-control.tsx`) sits at
 * the right, before the status: commit, push and open a pull request from
 * the thread's workspace. The "Open in" control
 * (`components/open-in/open-in-control.tsx`) comes just before it, opening
 * the workspace in an editor, and the Run control
 * (`components/run/run-control.tsx`) before that, running the project's
 * scripts in the thread's terminal drawer. The terminal and dock toggles end the row
 * (`./header-toggles`, shared with the New task page's header).
 *
 * A narrow header (a small window, the dock open) squeezes the project, the
 * title and the branch, the only parts that shrink. The branch is the one
 * worth keeping, so the title gives up twice as much; the project gives up
 * no more than the branch, since a name cut to its first letter says
 * nothing. Below `@lg` the header (a container, `header`) has the Commit
 * button drop its label for its icon and tooltip.
 *
 * While the sidebar is hidden, the header also leads with the window chrome
 * — the sidebar toggle, search and history (`ThreadHeaderChrome`) — rather
 * than the layout stacking a chrome row above it, and it becomes the window's
 * drag region, with its controls opted out.
 */

import type { ThreadDetailSnapshot, ThreadStatus } from "@poseidon/contracts/orchestration";

import type { DockPane } from "@/components/dock/dock-toggle";
import { BranchPicker } from "@/components/git/branch-picker";
import { GitActionsControl } from "@/components/git/git-actions-control";
import { OpenInControl } from "@/components/open-in/open-in-control";
import { RunControl } from "@/components/run/run-control";
import { ThreadHeaderChrome, useThreadHeaderChrome } from "@/components/Layout/window-chrome";
import { AgentBrowserIndicator } from "@/components/thread/agent-browser-indicator";
import { HeaderToggles } from "@/components/thread/header-toggles";
import { cn } from "@/lib/utils";
import { useProjects } from "@/state/hooks";
import { Folder, Spinner } from "@honeyicons/react";

const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting",
  error: "Error",
  archived: "Archived",
  deleted: "Deleted",
};

function StatusPill({ status }: { status: ThreadStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-hover px-2 py-0.5 type-micro",
        (status === "error" || status === "deleted") && "bg-removed-bg text-removed",
        status === "waiting" && "text-permission",
        (status === "idle" || status === "archived") && "text-muted-foreground",
      )}
    >
      {status === "running" ? <Spinner variant="bold" className="size-3" /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ThreadHeader({
  snapshot,
  dockTab,
  onDockToggle,
  onShowBrowser,
}: {
  snapshot: ThreadDetailSnapshot;
  /** What the dock shows — a tab or its launcher — or `undefined` when closed. */
  dockTab: DockPane | undefined;
  onDockToggle: () => void;
  /** Set while the agent uses the browser and its pane is not on screen. */
  onShowBrowser: (() => void) | null;
}) {
  const project = useProjects().find((candidate) => candidate.projectId === snapshot.projectId);
  const chrome = useThreadHeaderChrome();

  return (
    <header
      className={cn(
        "@container/header flex min-h-11 shrink-0 items-center gap-2 px-6 py-1.5",
        chrome && "app-region-drag min-h-(--chrome-height) pl-2",
      )}
    >
      <ThreadHeaderChrome />
      {/* The breadcrumb reads as one phrase, so it sits tighter than the
          controls around it. */}
      <div className={cn("flex min-w-0 items-center gap-1", chrome && "app-region-no-drag")}>
        {project === undefined ? null : (
          <>
            <span className="flex min-w-0 max-w-40 items-center gap-1.5 text-sm text-muted-foreground">
              <Folder variant="bold" className="size-4 shrink-0" />
              <span className="truncate">{project.name}</span>
            </span>
            <span aria-hidden className="shrink-0 text-sm text-muted-foreground/60">
              /
            </span>
          </>
        )}
        <h1 className="min-w-0 max-w-56 shrink-2 truncate text-sm font-medium text-foreground">
          {snapshot.title}
        </h1>
        <BranchPicker snapshot={snapshot} />
      </div>
      <div className="flex-1" />
      <div className={cn("flex shrink-0 items-center gap-2", chrome && "app-region-no-drag")}>
        {onShowBrowser === null ? null : (
          <AgentBrowserIndicator threadId={snapshot.threadId} onShow={onShowBrowser} />
        )}
        <RunControl
          projectId={snapshot.projectId}
          threadId={snapshot.threadId}
          ownerKey={snapshot.threadId}
        />
        <OpenInControl projectId={snapshot.projectId} threadId={snapshot.threadId} />
        <GitActionsControl projectId={snapshot.projectId} snapshot={snapshot} />
        {/* Idle is the resting state, not news: the pill shows only while
          something is happening or wrong. */}
        {snapshot.status === "idle" ? null : <StatusPill status={snapshot.status} />}
        <HeaderToggles
          terminalKey={snapshot.threadId}
          dockTab={dockTab}
          onDockToggle={onDockToggle}
        />
      </div>
    </header>
  );
}
