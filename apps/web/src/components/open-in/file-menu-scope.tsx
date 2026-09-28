/**
 * Which workspace a file menu acts in, handed down by the pane that lists the
 * files — the thread's Changes tab, the New task page's, the Files tab — so
 * the shared rows (`FileSection`, the Files results) need no new props.
 *
 * `threadId` is a real thread or `null`: the New task page's Changes list is
 * keyed by its draft, which is not a thread, so it gets `null` — the server
 * then opens paths under the project's folder, and no thread view is there to
 * answer "Open in Files tab". `root` is the thread's worktree when it has one
 * and the project's folder otherwise, for "Copy path"; `null` until the
 * project list has loaded.
 *
 * The provider reads the thread and project lists through selectors, so a
 * streaming turn does not re-render the pane or its rows: consumers change
 * only when the root does.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ProjectSummary, ThreadSummary } from "@poseidon/contracts/orchestration";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { getAppAtoms } from "@/state/app-runtime";

export interface FileMenuScope {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly root: string | null;
}

const FileMenuScopeContext = React.createContext<FileMenuScope | null>(null);

/** The pane's workspace, or `null` for a row rendered outside one. */
export const useFileMenuScope = (): FileMenuScope | null => React.useContext(FileMenuScopeContext);

export function FileMenuScopeProvider({
  projectId,
  threadId,
  children,
}: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly children: React.ReactNode;
}) {
  const atoms = getAppAtoms();
  const worktree = useAtomValue(
    atoms.threadListAtom(null),
    React.useCallback(
      (result: AsyncResult.AsyncResult<ReadonlyArray<ThreadSummary>, unknown>) =>
        threadId === null || !AsyncResult.isSuccess(result)
          ? null
          : (result.value.find((thread) => thread.threadId === threadId)?.worktree?.path ?? null),
      [threadId],
    ),
  );
  const projectRoot = useAtomValue(
    atoms.projectsAtom,
    React.useCallback(
      (result: AsyncResult.AsyncResult<ReadonlyArray<ProjectSummary>, unknown>) =>
        AsyncResult.isSuccess(result)
          ? (result.value.find((project) => project.projectId === projectId)?.workspaceRoot ?? null)
          : null,
      [projectId],
    ),
  );
  const root = worktree ?? projectRoot;
  const scope = React.useMemo(() => ({ projectId, threadId, root }), [projectId, threadId, root]);
  return <FileMenuScopeContext.Provider value={scope}>{children}</FileMenuScopeContext.Provider>;
}
