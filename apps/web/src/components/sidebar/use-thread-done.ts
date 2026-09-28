/**
 * `threadIsDone` bound to what it reads in the app: the `autoDoneAfterDays`
 * setting, this window's pins, and a clock that ticks once a minute — the
 * auto-done rule needs no finer grain. Every surface that splits Active from
 * Done (the tree, the thread keys, the menus, the selection bar) asks the one
 * predicate, so they cannot disagree about where a thread is.
 */

import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { threadIsDone, type DoneCandidate } from "@/components/sidebar/thread-done";
import { useThreadPins } from "@/components/sidebar/thread-pins";
import { useAppAtoms } from "@/lib/app-runtime";
import { useNow } from "@/lib/use-now";

export type IsDone = (thread: DoneCandidate & { readonly threadId: string }) => boolean;

export const useThreadIsDone = (): IsDone => {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const autoDoneAfterDays = AsyncResult.isSuccess(result)
    ? result.value?.autoDoneAfterDays
    : undefined;
  const [pins] = useThreadPins();
  const now = useNow(60_000);
  return React.useCallback<IsDone>(
    (thread) =>
      threadIsDone(thread, { now, autoDoneAfterDays, pinned: pins.includes(thread.threadId) }),
    [now, autoDoneAfterDays, pins],
  );
};
