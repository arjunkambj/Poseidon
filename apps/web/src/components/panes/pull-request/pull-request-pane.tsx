/**
 * The dock's Pull request tab: the pull request of the thread's branch
 * (`git.pullRequest.view`, through gh on the server) — its summary, its
 * checks and its reviews.
 *
 * It reads only while mounted, which is only while its tab shows. It rereads
 * on the refresh button, and on window return through the project's git
 * revision, which the thread header's git control bumps then — so the tab
 * needs no return hook of its own and there is no timer.
 *
 * Every state that is not a pull request is an `Empty`: loading, not
 * connected, gh missing or signed out (gh's own fix as the detail), no pull
 * request for the branch (named), and a failed read with a retry.
 */

import { useAtomValue } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { PullRequestDetail, PullRequestView } from "@poseidon/contracts/pullRequest";
import * as React from "react";

import {
  AlertTriangle,
  GitPullRequest,
  type HoneyIcon,
  Repeat,
  Spinner,
  WifiOff,
} from "@honeyicons/react";

import { PrChecks } from "./pr-checks";
import type { CommentActions } from "./pr-comment";
import { PrControls } from "./pr-controls";
import { PrReviews } from "./pr-reviews";
import { PrSummary } from "./pr-summary";
import {
  pullRequestQuery,
  type PullRequestQuery,
  usePullRequestAtoms,
  useRefreshPullRequests,
} from "./pull-request-atoms";
import { useCommentActions } from "./use-comment-actions";

/**
 * One state that is not a pull request. Unlike the other panes' one-line
 * message, the detail wraps: gh's reason is a sentence with the fix in it.
 */
function PaneMessage({
  icon: Glyph,
  text,
  detail,
  action,
}: {
  readonly icon: HoneyIcon;
  readonly text: string;
  readonly detail?: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Glyph variant="bold" />
        </EmptyMedia>
        <EmptyTitle>{text}</EmptyTitle>
        {detail === undefined ? null : (
          <EmptyDescription className="max-w-full break-words">{detail}</EmptyDescription>
        )}
      </EmptyHeader>
      {action === undefined ? null : <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function PullRequestPane({
  projectId,
  threadId,
  connected,
}: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly connected: boolean;
}) {
  const { pullRequestViewAtom } = usePullRequestAtoms();
  const query = pullRequestQuery<PullRequestView>(
    useAtomValue(pullRequestViewAtom({ projectId, threadId })),
  );
  const onRefresh = useRefreshPullRequests(projectId);
  const actions = useCommentActions(threadId);
  const renderControls = React.useCallback(
    (pullRequest: PullRequestDetail) => (
      <PrControls projectId={projectId} threadId={threadId} pullRequest={pullRequest} />
    ),
    [projectId, threadId],
  );
  return (
    <PullRequestPaneView
      query={query}
      connected={connected}
      onRefresh={onRefresh}
      actions={actions}
      renderControls={renderControls}
    />
  );
}

/**
 * The tab's body for one answer of the view. Memoised: the actions write the
 * thread's draft, so the container renders again as the person types, and
 * this need not.
 */
export const PullRequestPaneView = React.memo(function PullRequestPaneView({
  query,
  connected,
  onRefresh,
  actions,
  renderControls,
}: {
  readonly query: PullRequestQuery<PullRequestView> | null;
  readonly connected: boolean;
  readonly onRefresh: () => void;
  readonly actions: CommentActions;
  /** The summary's lifecycle actions and Fix menu; left out by the tests. */
  readonly renderControls?: (pullRequest: PullRequestDetail) => React.ReactNode;
}) {
  const retry = (
    <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
      <Repeat variant="bold" />
      Try again
    </Button>
  );

  if (query === null) {
    return connected ? (
      <PaneMessage icon={Spinner} text="Loading pull request…" />
    ) : (
      <PaneMessage icon={WifiOff} text="Not connected to the server." />
    );
  }
  if (query._tag === "broken") {
    return (
      <PaneMessage icon={AlertTriangle} text="Could not read the pull request." action={retry} />
    );
  }
  if (query._tag === "error") {
    return (
      <PaneMessage
        icon={AlertTriangle}
        text="Could not read the pull request."
        detail={query.message}
        action={retry}
      />
    );
  }
  const view = query.value;
  if (view.state === "unavailable") {
    return (
      <PaneMessage
        icon={GitPullRequest}
        text="The GitHub CLI is not ready."
        detail={view.reason}
        action={retry}
      />
    );
  }
  if (view.state === "none") {
    return (
      <PaneMessage
        icon={GitPullRequest}
        text="No pull request for this branch."
        detail={view.branch === null ? "The thread is not on a branch." : view.branch}
        action={retry}
      />
    );
  }
  const nowMs = Date.now();
  return (
    <div className="flex flex-col gap-3 pb-3">
      <PrSummary
        pullRequest={view.pullRequest}
        nowMs={nowMs}
        onRefresh={onRefresh}
        controls={renderControls?.(view.pullRequest)}
      />
      <PrChecks checks={view.pullRequest.checks} />
      <PrReviews pullRequest={view.pullRequest} nowMs={nowMs} actions={actions} />
    </div>
  );
});
