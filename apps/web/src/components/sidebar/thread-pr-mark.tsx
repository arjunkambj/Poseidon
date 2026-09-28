/**
 * A small pull request glyph on a thread row whose branch has a pull request,
 * tinted by its state (`@/lib/pull-request-tone`: open, draft, merged,
 * closed, or open with a failing check). Its tooltip reads
 * "PR #12 · Open · Checks failing", and a click opens that thread with the
 * dock on its Pull request tab.
 *
 * The marks are one `git.pullRequest.marks` listing per project, shared with
 * the dock's launcher (`useThreadPullRequestMark`), so a project's rows cost
 * one `gh pr list` together. They are reread when the project's git reads are
 * (the header's refresh on window return), on the tab's refresh and after a
 * write to the pull request, and on any window return through
 * `revisitPullRequestMarks` — one subscription per project, and at most one
 * listing a minute (`MARKS_MIN_INTERVAL_MS`). Nothing reads on a timer. gh
 * missing or signed out answers no marks, so no row shows a glyph.
 *
 * The glyph sits inside the row's link, so it is a `span` with the button
 * role whose click stops before the link sees it. Keyboard users reach the
 * same place through "Open pull request" in the row's menu
 * (`./thread-menu-items`).
 */

import { RegistryContext } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";
import type { PullRequestMark } from "@poseidon/contracts/pullRequest";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { usePullRequestAtoms } from "@/components/panes/pull-request/pull-request-atoms";
import { useThreadPullRequestMark } from "@/components/panes/pull-request/use-thread-pull-request";
import { pullRequestMarkLabel, pullRequestTone } from "@/lib/pull-request-tone";
import { cn } from "@/lib/utils";
import { useSharedWindowReturn } from "@/lib/window-return";

/**
 * The thread's mark, or `null`. Also asks for the project's marks again when
 * the user comes back to the window — throttled, and once per project however
 * many rows ask.
 */
export const useThreadPrMark = (
  thread: Pick<ThreadSummary, "projectId" | "threadId">,
): PullRequestMark | null => {
  const registry = React.useContext(RegistryContext);
  const { revisitPullRequestMarks } = usePullRequestAtoms();
  useSharedWindowReturn(`pull-request-marks:${thread.projectId}`, () =>
    revisitPullRequestMarks(registry, thread.projectId),
  );
  return useThreadPullRequestMark(thread.projectId, thread.threadId);
};

/** Opens the thread on its Pull request tab, without following the row's link. */
export const useOpenPullRequestTab = (threadId: ThreadId) => {
  const navigate = useNavigate();
  return React.useCallback(
    () =>
      void navigate({ to: "/t/$threadId", params: { threadId }, search: { pane: "pullRequest" } }),
    [navigate, threadId],
  );
};

export function ThreadPrMark({
  threadId,
  mark,
  className,
}: {
  readonly threadId: ThreadId;
  readonly mark: PullRequestMark | null;
  readonly className?: string;
}) {
  const open = useOpenPullRequestTab(threadId);
  if (mark === null) {
    return null;
  }
  const tone = pullRequestTone(mark);
  const label = pullRequestMarkLabel(mark);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="button"
            tabIndex={-1}
            aria-label={label}
            data-pull-request={tone.kind}
            className={cn("flex shrink-0", className)}
            onClick={(event) => {
              // Stops the row's link, which would open the thread with no tab.
              event.preventDefault();
              event.stopPropagation();
              open();
            }}
          />
        }
      >
        <tone.icon variant="bold" className={cn("size-3.5", tone.tone)} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
