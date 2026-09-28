/**
 * The New task page's header: one row, like a thread's (`./thread-header`),
 * holding what already works before any thread exists — for the picked
 * project's own folder, since there is no thread (and so no worktree) yet.
 *
 * - The Run control (`@/components/run/run-control`): the project's scripts,
 *   run in the project's own terminals.
 * - The git actions (`@/components/git/git-actions-control`) with the project
 *   alone: commit, push and open a pull request from the project's folder.
 * - The terminal toggle, for the project's own terminals
 *   (`ProjectTerminal`), and the dock toggle, for its dock
 *   (`./header-toggles`). Before the toggles, a count of the project's
 *   shells still running (`ProjectTerminalsBadge`), when there are any.
 *
 * There is no title or branch picker: the greeting already names the
 * project, and the branch is picked for the thread in the composer's
 * workspace picker.
 *
 * While the sidebar is hidden, the header also leads with the window chrome
 * (`ThreadHeaderChrome`) and becomes the window's drag region, the way a
 * thread's does, so the page keeps one top row — the layout stacks no chrome
 * row above `/`. With no project to act on (no server, no projects yet) it
 * holds the chrome alone, and nothing at all while the sidebar shows it.
 */

import type { ProjectId } from "@poseidon/contracts/ids";
import { terminalOwnerKey } from "@poseidon/contracts/terminal";

import type { DockPane } from "@/components/dock/dock-toggle";
import { GitActionsControl } from "@/components/git/git-actions-control";
import { ThreadHeaderChrome, useThreadHeaderChrome } from "@/components/Layout/window-chrome";
import { RunControl } from "@/components/run/run-control";
import { ProjectTerminalsBadge } from "@/components/terminal/project-terminals-badge";
import { HeaderToggles } from "@/components/thread/header-toggles";
import { cn } from "@/lib/utils";

export function StartThreadHeader({
  controls,
}: {
  /** The picked project and its dock; `null` when there is none to act on. */
  controls: {
    readonly projectId: ProjectId;
    readonly dockTab: DockPane | undefined;
    readonly onDockToggle: () => void;
  } | null;
}) {
  const chrome = useThreadHeaderChrome();
  if (!chrome && controls === null) {
    return null;
  }

  return (
    <header
      className={cn(
        "@container/header flex min-h-11 shrink-0 items-center gap-2 px-6 py-1.5",
        chrome && "app-region-drag min-h-(--chrome-height) pl-2",
      )}
    >
      <ThreadHeaderChrome />
      <div className="flex-1" />
      {controls === null ? null : (
        <div className={cn("flex shrink-0 items-center gap-2", chrome && "app-region-no-drag")}>
          {/* Per project: a dialog, a draft or a run in flight for one
              project must not carry over to the next one picked. */}
          <RunControl
            key={controls.projectId}
            projectId={controls.projectId}
            ownerKey={terminalOwnerKey({ projectId: controls.projectId })}
          />
          <GitActionsControl key={controls.projectId} projectId={controls.projectId} />
          <ProjectTerminalsBadge projectId={controls.projectId} />
          <HeaderToggles
            terminalKey={terminalOwnerKey({ projectId: controls.projectId })}
            dockTab={controls.dockTab}
            onDockToggle={controls.onDockToggle}
          />
        </div>
      )}
    </header>
  );
}
