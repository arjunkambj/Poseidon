/**
 * The row of controls under the Pull request tab's summary: the lifecycle
 * actions (`PrActionsMenu`), bound to the tab's thread. A lifecycle write runs as a one-shot on the client runtime
 * (`runPullRequestAction`), which rereads the tab and the sidebar's marks once
 * it settles.
 */

import { RegistryContext } from "@effect/atom-react";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { PullRequestDetail } from "@poseidon/contracts/pullRequest";
import * as Exit from "effect/Exit";
import * as React from "react";
import { toast } from "sonner";

import { describeExitError } from "@/lib/app-runtime";

import { prActions, runPrAction, type MergeMethod, type PrActionKind } from "./pr-actions";
import { PrActionsMenu } from "./pr-actions-menu";
import { usePullRequestAtoms } from "./pull-request-atoms";

export function PrControls({
  projectId,
  threadId,
  pullRequest,
}: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly pullRequest: PullRequestDetail;
}) {
  const registry = React.useContext(RegistryContext);
  const { runPullRequestAction } = usePullRequestAtoms();

  const onRun = React.useCallback(
    (kind: PrActionKind, method: MergeMethod) =>
      void runPrAction(
        async (action, headRefOid) => {
          const exit = await runPullRequestAction(registry, {
            scope: { projectId, threadId },
            number: pullRequest.number,
            ...(headRefOid === undefined ? {} : { headRefOid }),
            action,
          });
          return Exit.isSuccess(exit)
            ? { ok: true, view: exit.value }
            : { ok: false, message: describeExitError(exit, "GitHub refused it") };
        },
        toast,
        pullRequest,
        kind,
        method,
      ),
    [projectId, pullRequest, registry, runPullRequestAction, threadId],
  );
  if (prActions(pullRequest).length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <PrActionsMenu pullRequest={pullRequest} onRun={onRun} />
    </div>
  );
}
