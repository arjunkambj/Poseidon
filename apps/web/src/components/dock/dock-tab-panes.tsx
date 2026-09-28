/**
 * What each dock tab kind renders — the pane half of the kind registry in
 * `./dock-tab-meta`. The dock calls the active tab's renderer only, so a pane
 * mounts when its tab shows and unmounts when another does.
 */

import type * as React from "react";

import type { ProjectId } from "@poseidon/contracts/ids";
import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";

import { BrowserPane } from "@/components/panes/browser/browser-pane";
import { ChangesPane } from "@/components/panes/changes/changes-pane";
import { ProjectChangesPane } from "@/components/panes/changes/project-changes-pane";
import { FilesPane } from "@/components/panes/files/files-pane";
import { workspaceKey } from "@/lib/workspace-key";

import type { DockScope } from "./dock-scope";
import type { DockTab } from "./dock-toggle";

/** What a pane renderer gets from the dock. */
export interface DockPaneContext {
  readonly scope: DockScope;
  /** The thread beside the dock, or null on the New task page. */
  readonly snapshot: ThreadDetailSnapshot | null;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  /** Focus the Files search as the Files tab mounts — set by its key. */
  readonly focusFilesSearch: boolean;
  readonly onFilesSearchFocused: (() => void) | undefined;
}

export const DOCK_TAB_PANES: Record<DockTab, (ctx: DockPaneContext) => React.ReactNode> = {
  changes: (ctx) =>
    ctx.snapshot !== null ? (
      <ChangesPane snapshot={ctx.snapshot} />
    ) : "draftId" in ctx.scope ? (
      <ProjectChangesPane projectId={ctx.scope.projectId} draftId={ctx.scope.draftId} />
    ) : null,
  // Unmounting the pane is safe: its tabs are webviews the browser host keeps
  // above the routes, and the pane only marks where the selected one goes.
  browser: (ctx) =>
    ctx.snapshot !== null ? (
      <BrowserPane threadId={ctx.snapshot.threadId} projectId={ctx.snapshot.projectId} />
    ) : null,
  files: (ctx) => (
    <FilesPane
      // Per thread (or project): the pane saves its scroll for the workspace
      // it was mounted for as it unmounts.
      key={workspaceKey({ projectId: ctx.projectId, threadId: ctx.snapshot?.threadId })}
      projectId={ctx.projectId}
      threadId={ctx.snapshot?.threadId ?? null}
      connected={ctx.connected}
      focusSearch={ctx.focusFilesSearch}
      onSearchFocused={ctx.onFilesSearchFocused}
    />
  ),
};
