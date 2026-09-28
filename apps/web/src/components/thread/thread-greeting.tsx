/**
 * The middle of a thread with nothing in it yet — a fresh thread, or `/`
 * before its first message: one line asking what to build, naming the
 * project the agent will work in. Both screens pin the composer underneath,
 * so starting a thread and opening an empty one look the same.
 *
 * A thread with its own worktree says so underneath, with the branch and the
 * path, because the agent will work there rather than in the project's folder.
 * A fork names the thread it was forked from (`./forked-from-link`).
 */

import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { ForkedFrom, ProjectSummary } from "@poseidon/contracts/orchestration";
import { GitBranch } from "@honeyicons/react";

import { ForkedFromLink } from "@/components/thread/forked-from-link";

export function ThreadGreeting({
  project,
  worktree,
  forkedFrom,
}: {
  readonly project: ProjectSummary | undefined;
  readonly worktree?: ThreadWorktree | undefined;
  readonly forkedFrom?: ForkedFrom | undefined;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h2 className="text-2xl font-medium tracking-tight text-foreground">
        {project === undefined ? (
          "What are we cooking today?"
        ) : (
          <>
            What are we cooking in{" "}
            <span
              className="underline decoration-muted-foreground decoration-dotted decoration-1 underline-offset-4"
              title={project.workspaceRoot}
            >
              {project.name}
            </span>
            ?
          </>
        )}
      </h2>
      {worktree === undefined ? null : (
        <p className="flex max-w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <GitBranch variant="bold" className="size-4 shrink-0" />
          <span className="shrink-0 font-mono">{worktree.branch}</span>
          <span className="shrink-0">in</span>
          <span className="min-w-0 truncate font-mono" title={worktree.path}>
            {worktree.path}
          </span>
        </p>
      )}
      {forkedFrom === undefined ? null : <ForkedFromLink forkedFrom={forkedFrom} />}
    </div>
  );
}
