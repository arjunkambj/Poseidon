/**
 * Once per launch, clears the browsing data of threads deleted while this
 * window was not watching: with the app closed, from another client, or in
 * the grace before `useThreadTeardown` counted them gone. The shell compares
 * the partitions on disk with the ids handed over and clears the rest, but
 * only from the default home: a scratch `POSEIDON_HOME` shares the partitions
 * and lists none of the real threads, so there the shell clears nothing.
 *
 * The list is handed over only once it has held still for a while and is not
 * empty, since an empty list is also what a resnapshot looks like before its
 * snapshot lands; with no threads left at all, the leftovers wait for the
 * next launch that has one.
 */
import * as React from "react";

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

type PaneBridge = NonNullable<NonNullable<Window["poseidon"]>["browserPane"]>;

/** How long the connected, non-empty list must hold before it is trusted. */
const SWEEP_AFTER_MS = 10_000;

export const usePartitionSweep = (
  bridge: PaneBridge,
  threads: ReadonlyArray<ThreadSummary> | null,
  connected: boolean,
) => {
  const done = React.useRef(false);

  React.useEffect(() => {
    if (done.current || bridge.clearStale === undefined) return;
    if (threads === null || threads.length === 0 || !connected) return;
    const live = threads.map((thread) => thread.threadId as string);
    const timer = window.setTimeout(() => {
      done.current = true;
      void bridge.clearStale?.(live).catch((error: unknown) => {
        console.warn(`[browser] could not clear deleted threads' data: ${String(error)}`);
      });
    }, SWEEP_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [bridge, threads, connected]);
};
