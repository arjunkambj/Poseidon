/**
 * Whether a thread's branch has a pull request, from the project's marks
 * (`git.pullRequest.marks`) — one listing shared by everything that asks, so
 * the dock's launcher offering the Pull request tab costs no gh call of its
 * own. Outside a thread (the New task page) nothing is read.
 */

import { useAtomValue } from "@effect/atom-react";
import type { GitQuery } from "@poseidon/client-runtime/gitAtoms";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { PullRequestMark, PullRequestMarks } from "@poseidon/contracts/pullRequest";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import { usePullRequestAtoms } from "./pull-request-atoms";

type MarksResult = AsyncResult.AsyncResult<GitQuery<PullRequestMarks>, unknown>;

/** Stands in for the marks where there is no thread to mark. */
const NO_MARKS: Atom.Atom<MarksResult> = Atom.make<MarksResult>(AsyncResult.initial());

/** The thread's mark, or `null` when its branch has none (or the marks are not in yet). */
const useThreadPullRequestMark = (
  projectId: ProjectId,
  threadId: ThreadId | null,
): PullRequestMark | null => {
  const { pullRequestMarksAtom } = usePullRequestAtoms();
  const atom: Atom.Atom<MarksResult> =
    threadId === null ? NO_MARKS : pullRequestMarksAtom(projectId);
  return useAtomValue(
    atom,
    React.useCallback(
      (result: MarksResult) =>
        AsyncResult.isSuccess(result) && result.value._tag === "ok"
          ? (result.value.value.marks.find((mark) => mark.threadId === threadId) ?? null)
          : null,
      [threadId],
    ),
  );
};

export const useThreadHasPullRequest = (projectId: ProjectId, threadId: ThreadId | null): boolean =>
  useThreadPullRequestMark(projectId, threadId) !== null;
