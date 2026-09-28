/**
 * Compacting on demand: whether the thread can, and why not right now.
 *
 * Compaction is the harness's own command, so asking for it is a turn whose
 * text is `/compact` — exactly what a typed `/compact` sends; the connector
 * hands it to its CLI as that CLI's own command. Only a harness that declared
 * `capabilities.compaction` is offered it, read from the thread's *bound*
 * session like `canSteer` (`./send-mode`): before a session binds nothing has
 * said so, and the instance's catalogue entry is not the session the command
 * would reach.
 */

import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

/** The text of the turn that asks the harness to compact. */
export const COMPACT_COMMAND = "/compact";

/** Shown beneath the disabled button while a turn runs. */
export const COMPACT_WHILE_RUNNING = "Wait for the running turn to finish";

/** The thread's bound session said it can compact on demand. */
export const canCompact = (
  sessionCapabilities: ConnectorCapabilities | null | undefined,
): boolean => sessionCapabilities?.compaction === true;

/** Why "Compact now" is disabled, or null when it can run. */
export const compactRefusal = ({
  running,
  pending,
}: {
  /** A turn is in flight; `/compact` would only queue behind it. */
  readonly running: boolean;
  /** A compact dispatch has not answered yet. */
  readonly pending: boolean;
}): string | null => {
  if (running) {
    return COMPACT_WHILE_RUNNING;
  }
  return pending ? "Compacting…" : null;
};
