/**
 * What the dock is beside — a thread, or a project on the New task page — and
 * the kind of scope that decides which tab kinds it offers (`./dock-tab-meta`).
 */

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";

/**
 * What the dock is beside: a thread, or — on the New task page — a project
 * with no thread yet, and the page's draft its "Add to chat" writes into.
 */
export type DockScope =
  | { readonly snapshot: ThreadDetailSnapshot }
  | { readonly projectId: ProjectId; readonly draftId: ThreadId };

/** A thread's dock, or a project's before any thread exists. */
export type DockScopeKind = "thread" | "project";

export const dockScopeKind = (scope: DockScope): DockScopeKind =>
  "snapshot" in scope ? "thread" : "project";
