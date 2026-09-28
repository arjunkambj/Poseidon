/**
 * Where a new thread will work, picked beside the project on the start screen:
 * **Local** — the project's own folder, shared with its other local threads —
 * or a **New worktree**, a branch and directory of its own cut from a base
 * branch (`start-in-worktree.ts` runs that sequence).
 *
 * The choice is remembered per project (`useWorkspaceMode`); a project never
 * picked for opens on Settings → Models' Default workspace. A project that is
 * not a git repository cannot have worktrees, so the option is disabled and
 * the picker says why; a remembered "worktree" then reads as local. The base
 * list is `git.branches` of the project's own checkout: local branches first,
 * remote ones after, opening on the repository's default branch.
 */

import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { GitBranchList } from "@poseidon/contracts/git";
import type { ProjectId } from "@poseidon/contracts/ids";

import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import { useAppAtoms } from "@/lib/app-runtime";
import { useWorkspaceMode, type WorkspaceMode } from "@/state/ui";
import { Computer, GitBranch, GitFork } from "@honeyicons/react";

const NOT_A_REPOSITORY = "New worktree needs a git repository — this project's folder is not one";

const MODE_LABELS: Record<WorkspaceMode, string> = {
  local: "Local",
  worktree: "New worktree",
};

export interface WorkspaceChoice {
  /** What a send does now: a remembered "worktree" reads as local outside a repository. */
  readonly mode: WorkspaceMode;
  readonly setMode: (mode: WorkspaceMode) => void;
  /** The branch a new worktree is cut from; `undefined` lets the server use the default. */
  readonly baseBranch: string | undefined;
  readonly setBaseBranch: (branch: string) => void;
  /** The project's branches once listed; `null` while loading or when the list failed. */
  readonly branches: GitBranchList | null;
  /** `false` only when the server said the folder is not a repository. */
  readonly worktreeAllowed: boolean;
}

/** The start screen's workspace choice for one project. */
export const useWorkspaceChoice = (projectId: ProjectId): WorkspaceChoice => {
  const { gitBranchesAtom } = useGitAtoms();
  const result = useAtomValue(gitBranchesAtom({ projectId }));
  const branches =
    AsyncResult.isSuccess(result) && result.value._tag === "ok" ? result.value.value : null;
  const worktreeAllowed = branches === null || branches.isRepository;

  const settings = useAtomValue(useAppAtoms().settingsAtom);
  const fallback = AsyncResult.isSuccess(settings) ? settings.value?.defaults.workspace : undefined;
  const [remembered, setMode] = useWorkspaceMode(projectId, fallback ?? "local");
  // The pick belongs to the project it was made for; another project opens on
  // its own default branch.
  const [picked, setPicked] = React.useState<{ projectId: ProjectId; branch: string } | null>(null);
  const setBaseBranch = React.useCallback(
    (branch: string) => setPicked({ projectId, branch }),
    [projectId],
  );
  const pickedBranch = picked?.projectId === projectId ? picked.branch : undefined;

  return {
    mode: worktreeAllowed ? remembered : "local",
    setMode,
    baseBranch: pickedBranch ?? branches?.defaultBranch ?? undefined,
    setBaseBranch,
    branches,
    worktreeAllowed,
  };
};

function BaseBranchPicker({
  choice,
  disabled,
}: {
  readonly choice: WorkspaceChoice;
  readonly disabled: boolean;
}) {
  const all = choice.branches?.branches ?? [];
  const groups = [
    { label: "Local", branches: all.filter((branch) => branch.kind === "local") },
    { label: "Remote", branches: all.filter((branch) => branch.kind === "remote") },
  ].filter((group) => group.branches.length > 0);

  return (
    <Select
      value={choice.baseBranch ?? null}
      disabled={disabled || all.length === 0}
      onValueChange={(next) => {
        if (typeof next === "string" && next.length > 0) {
          choice.setBaseBranch(next);
        }
      }}
      items={all.map((branch) => ({ value: branch.name, label: branch.name }))}
    >
      <SelectTrigger
        aria-label="Base branch"
        title="The branch the new worktree is cut from"
        variant="composer"
        className="min-w-0"
      >
        <span className="flex min-w-0 items-center gap-1">
          <GitBranch variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
          <SelectValue placeholder="Default branch" />
        </span>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-64 max-w-80">
        {groups.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.branches.map((branch) => (
              // `*:min-w-0` lets the item's text wrapper narrow below its
              // content, so a long name ellipsizes instead of being clipped;
              // the full name is in the tooltip.
              <SelectItem key={branch.name} value={branch.name} className="*:min-w-0">
                <span className="truncate font-mono text-xs" title={branch.name}>
                  {branch.name}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

export function WorkspaceModePicker({
  choice,
  disabled = false,
}: {
  readonly choice: WorkspaceChoice;
  readonly disabled?: boolean;
}) {
  const Glyph = choice.mode === "worktree" ? GitFork : Computer;
  const select = (
    <Select
      value={choice.mode}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "local" || next === "worktree") {
          choice.setMode(next);
        }
      }}
      items={(["local", "worktree"] as const).map((mode) => ({
        value: mode,
        label: MODE_LABELS[mode],
      }))}
    >
      <SelectTrigger aria-label="Workspace" variant="composer" className="min-w-0">
        <span className="flex min-w-0 items-center gap-1">
          <Glyph variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-64">
        <SelectGroup>
          <SelectItem value="local">
            <span className="flex min-w-0 flex-col">
              <span>{MODE_LABELS.local}</span>
              <span className="text-xs text-muted-foreground">The project's own folder</span>
            </span>
          </SelectItem>
          <SelectItem value="worktree" disabled={!choice.worktreeAllowed}>
            <span className="flex min-w-0 flex-col">
              <span>{MODE_LABELS.worktree}</span>
              <span className="text-xs text-muted-foreground">
                {choice.worktreeAllowed ? "Its own branch and folder" : "Needs a git repository"}
              </span>
            </span>
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {choice.worktreeAllowed ? (
        select
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex min-w-0" />}>
            {select}
          </TooltipTrigger>
          <TooltipContent>{NOT_A_REPOSITORY}</TooltipContent>
        </Tooltip>
      )}
      {choice.mode === "worktree" ? <BaseBranchPicker choice={choice} disabled={disabled} /> : null}
    </span>
  );
}
