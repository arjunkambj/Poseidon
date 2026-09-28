/**
 * The New task page around its greeting and composer, once a project is
 * picked: the header (`./start-thread-header`), the project's terminal drawer
 * under the column and its dock beside it — the same frame a thread has, for
 * the project's own folder, since no thread exists yet.
 *
 * - The terminals are the project's (`ProjectTerminal`), never keyed by the
 *   page's draft id: the thread that draft becomes may run in a new worktree,
 *   and the server has no thread by that id until it is sent. A selection
 *   quoted from them goes into that draft, though, since it is the composer
 *   on screen. When the first message starts a local thread, the composer
 *   hands them to it (`useTerminalHandOver`), open drawer and all; a
 *   worktree thread leaves them with the project.
 * - The dock (`RightDock`, project scope) offers Changes and Files. What it
 *   shows travels in `/`'s `?pane=`, and `useDockState` gives it the thread
 *   dock's rules — closed by default, the launcher loading nothing until a
 *   tab is picked, the toggle going back to the last tab — with its memory
 *   kept per project (`workspaceKey`).
 *
 * It publishes `newTaskOpen`, which the dock keys' clause names beside
 * `threadOpen`, and answers `dock.toggle`, `dock.changes` and `dock.files`
 * (`DockShortcuts`); `terminal.toggle` is the drawer's, and `git.commit` and
 * `git.push` the header's git actions'. `browserPane.toggle` is left alone:
 * there is no thread browser to show.
 */

import { useNavigate } from "@tanstack/react-router";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import * as React from "react";

import type { DockPane } from "@/components/dock/dock-toggle";
import { RightDock } from "@/components/dock/right-dock";
import { useDockState } from "@/components/dock/use-dock-state";
import { ProjectTerminal } from "@/components/terminal/owned-terminal";
import { StartThreadHeader } from "@/components/thread/start-thread-header";
import { DockShortcuts } from "@/components/thread/thread-shortcuts";
import { useKeybindingFlag } from "@/lib/shortcuts";
import { workspaceKey } from "@/lib/workspace-key";

export function StartThreadWorkspace({
  projectId,
  draftId,
  dockTab,
  children,
}: {
  projectId: ProjectId;
  /** The id the page's draft is kept under, and the thread will get. */
  draftId: ThreadId;
  /** What `?pane=` says the dock shows; `undefined` when it is closed. */
  dockTab: DockPane | undefined;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const navigateDock = React.useCallback(
    (tab: DockPane | null) =>
      void navigate({ to: "/", search: { pane: tab ?? undefined }, replace: true }),
    [navigate],
  );
  const dock = useDockState({ memoryKey: workspaceKey({ projectId }), dockTab, navigateDock });
  useKeybindingFlag("newTaskOpen", true);

  return (
    // The same row as a thread's: the dock overlays when it cannot fit both.
    <div className="@container/thread relative flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col @min-[640px]/thread:min-w-90">
        <DockShortcuts dockTab={dockTab} onToggle={dock.toggleDock} onShow={dock.showDockTab} />
        <StartThreadHeader controls={{ projectId, dockTab, onDockToggle: dock.toggleDock }} />
        {children}
        <ProjectTerminal key={projectId} projectId={projectId} draftId={draftId} />
      </section>
      {dock.phase !== null && dock.shownDockTab !== undefined ? (
        <RightDock
          pane={dock.shownDockTab}
          phase={dock.phase}
          onPaneChange={dock.setDockTab}
          openTabs={dock.openTabs}
          onCloseTab={dock.closeTab}
          scope={{ projectId, draftId }}
          focusFilesSearch={dock.focusFilesSearch}
          onFilesSearchFocused={dock.onFilesSearchFocused}
          focusLauncher={dock.focusLauncher}
          onLauncherFocused={dock.onLauncherFocused}
        />
      ) : null}
    </div>
  );
}
