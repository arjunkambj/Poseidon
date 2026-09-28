/**
 * The timeline's context value (`thread-context.tsx`), derived from the
 * snapshot and kept stable while a turn streams.
 *
 * - The checkpoints are the fold's, intersected with `checkpoints.list`
 *   (`availableCheckpoints`). The list is read per revision — the number of
 *   checkpoints the fold holds — so a new checkpoint asks again and a list
 *   read before it can never hide it; until the answer comes, or when it
 *   fails, the fold stands alone.
 * - A restore settling — restored or failed — rereads every git read of the
 *   project, the checkpoint list among them: the worktree moved, and a
 *   restore that failed on a pruned ref has just shown the list is stale.
 *   The Changes pane follows along the same way it follows its own restores.
 * - The restores are the snapshot's own: the server records each one after
 *   the latest turn, and the client's fold does the same between snapshots.
 * - The turn order is recomputed on every item change but only replaced when
 *   a turn is added, so a streamed delta does not rerender every row.
 * - The workspace revision counts the turns and restores that settled while
 *   the timeline was mounted: each may have created or removed files, so the
 *   file chips' existence checks are asked again under the new one.
 * - The connection is the client runtime's in context, so the fixture page
 *   reads its scripted one.
 */

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { TurnId } from "@poseidon/contracts/ids";
import type { CheckpointRestore, ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import type { TimelineThread } from "@/components/timeline/thread-context";
import {
  availableCheckpoints,
  restoreBlockedReason,
  turnOrder,
  workspaceSettled,
} from "@/components/timeline/turn-checkpoints";
import { useClientRuntime } from "@/lib/client-runtime";
import { turnInFlight } from "@/lib/turn";

// One empty list, so a thread with no restores keeps the context value stable.
const NO_RESTORES: ReadonlyArray<CheckpointRestore> = [];

export const useTimelineThreadValue = (snapshot: ThreadDetailSnapshot): TimelineThread => {
  const { threadId, projectId, items } = snapshot;
  const git = useGitAtoms();
  const registry = React.useContext(RegistryContext);

  const connection = useAtomValue(useClientRuntime().connectionStateAtom);
  const connected = AsyncResult.isSuccess(connection) && connection.value.status === "connected";

  const fold = snapshot.checkpoints;
  const listedResult = useAtomValue(
    git.checkpointsAtom({ projectId, threadId, revision: String(fold.length) }),
  );
  const listed =
    AsyncResult.isSuccess(listedResult) && listedResult.value._tag === "ok"
      ? listedResult.value.value
      : null;
  const checkpoints = React.useMemo(() => availableCheckpoints(fold, listed), [fold, listed]);
  const restores = snapshot.restores ?? NO_RESTORES;

  const restoring = (snapshot.restoring ?? null) !== null;
  const wasRestoring = React.useRef(restoring);
  React.useEffect(() => {
    if (wasRestoring.current && !restoring) {
      git.refreshProject(registry, projectId);
    }
    wasRestoring.current = restoring;
  }, [restoring, git, registry, projectId]);

  // Joined into one string so the memo below sees a primitive that only
  // changes when a turn is added.
  const orderKey = React.useMemo(() => turnOrder(items).join(" "), [items]);
  const order = React.useMemo(
    () => (orderKey === "" ? [] : (orderKey.split(" ") as TurnId[])),
    [orderKey],
  );

  const turnRunning = turnInFlight(snapshot);
  const blocked = restoreBlockedReason({ connected, restoring, turnRunning });

  // Counted during render, so the revision changes in the same render as the
  // turn or restore that settled rather than in a second one after it.
  const [settles, setSettles] = React.useState({ count: 0, restoring, turnRunning });
  if (settles.restoring !== restoring || settles.turnRunning !== turnRunning) {
    const now = { restoring, turnRunning };
    setSettles({ count: settles.count + (workspaceSettled(settles, now) ? 1 : 0), ...now });
  }
  const workspaceRevision = String(settles.count);

  return React.useMemo(
    () => ({
      threadId,
      projectId,
      checkpoints,
      restores,
      restoreBlockedReason: blocked,
      turnOrder: order,
      workspaceRevision,
      connected,
      runningTurnId: snapshot.currentTurnId,
    }),
    [
      threadId,
      projectId,
      checkpoints,
      restores,
      blocked,
      order,
      workspaceRevision,
      connected,
      snapshot.currentTurnId,
    ],
  );
};
