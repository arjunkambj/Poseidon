/**
 * Settings → General's "Confirm before deleting a thread". On (the default),
 * every way of deleting a thread opens its confirmation first. Off, the
 * delete runs at once with the dialog's own defaults: a worktree no other
 * thread still works in is removed too, its branch kept. The removal's second
 * confirmation — uncommitted work would be lost — still asks either way; that
 * is `./delete-thread`'s, and this never skips it.
 *
 * `requestThreadDelete` is the pure decision; `useRequestThreadDelete` binds
 * it to the setting, the thread list and `useDeleteThread`.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";
import { AsyncResult } from "effect/unstable/reactivity";

import { worktreeRemovers } from "@/components/sidebar/delete-thread";
import { useDeleteThread } from "@/components/sidebar/use-delete-thread";
import { useAppAtoms } from "@/lib/app-runtime";
import { useThreadList } from "@/state/hooks";

export interface ThreadDeleteRequest {
  /** Whether the setting asks first. */
  readonly confirm: boolean;
  /** The threads to delete, in the order the dialog would delete them. */
  readonly targets: ReadonlyArray<ThreadSummary>;
  /** Every thread the client knows, to keep a worktree another thread still uses. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly openDialog: () => void;
  readonly remove: (thread: ThreadSummary, removeWorktree: boolean) => void;
}

/**
 * Opens the confirmation, or deletes `targets` at once as its defaults would.
 * True when it deleted, so a caller can let go of what it was deleting.
 */
export const requestThreadDelete = (request: ThreadDeleteRequest): boolean => {
  if (request.confirm) {
    request.openDialog();
    return false;
  }
  const removers = worktreeRemovers(request.targets, request.threads);
  for (const thread of request.targets) {
    request.remove(thread, removers.has(thread.threadId));
  }
  return true;
};

/** The setting, on until the settings document says otherwise. */
export const useConfirmThreadDelete = (): boolean => {
  const result = useAtomValue(useAppAtoms().settingsAtom);
  return (AsyncResult.isSuccess(result) ? result.value?.confirmThreadDelete : undefined) ?? true;
};

/** `request(targets, openDialog)`: `requestThreadDelete` with the setting and the thread list. */
export const useRequestThreadDelete = () => {
  const confirm = useConfirmThreadDelete();
  const threads = useThreadList();
  const remove = useDeleteThread();
  return (targets: ReadonlyArray<ThreadSummary>, openDialog: () => void): boolean =>
    requestThreadDelete({
      confirm,
      targets,
      threads,
      openDialog,
      remove: (thread, removeWorktree) => void remove(thread, removeWorktree),
    });
};
