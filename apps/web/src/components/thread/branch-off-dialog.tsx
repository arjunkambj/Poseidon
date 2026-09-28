/**
 * The fork dialog, mounted once above the routes (`BranchOffHost`) and opened
 * by `useRequestBranchOff` from a user message's footer or a thread's menu.
 *
 * It asks for the new thread's title, prefilled "<title> (fork)", and where
 * it works: **This workspace** — the source's own worktree, or the project's
 * folder — or a **New worktree**, disabled with the reason when the project
 * is not a git repository. The new worktree runs the start screen's sequence,
 * and its panel (`WorktreeSetupPanel`) shows each step and, when the setup
 * script fails, its output with Start anyway and Discard. Closing the dialog
 * part-way leaves nobody to choose, so the worktree is discarded, as leaving
 * the start screen does.
 *
 * On success the dialog closes and the new thread opens with its composer
 * focused; the fork's first message carries the source's conversation to the
 * harness (the server's `forkSeed.ts`).
 */

import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import { Input } from "@poseidon/ui/components/input";
import { Label } from "@poseidon/ui/components/label";
import { ToggleGroup, ToggleGroupItem } from "@poseidon/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { ProjectId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { DialogActions } from "@/components/dialog-actions";
import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import { forkTitle, type BranchOffRequest } from "@/components/thread/branch-off";
import { useBranchOff, useBranchOffRequest } from "@/components/thread/use-branch-off";
import { WorktreeSetupPanel } from "@/components/thread/worktree-setup-panel";
import { useThreadList } from "@/state/hooks";
import { Spinner } from "@honeyicons/react";

type Workspace = "here" | "worktree";

const NOT_A_REPOSITORY = "New worktree needs a git repository — this project's folder is not one";

/** False only once the server has said the project's folder is not a repository. */
const useWorktreeAllowed = (projectId: ProjectId): boolean => {
  const result = useAtomValue(useGitAtoms().gitBranchesAtom({ projectId }));
  return AsyncResult.isSuccess(result) && result.value._tag === "ok"
    ? result.value.value.isRepository
    : true;
};

function WorkspacePicker({
  value,
  onChange,
  worktreeAllowed,
  disabled,
}: {
  readonly value: Workspace;
  readonly onChange: (next: Workspace) => void;
  readonly worktreeAllowed: boolean;
  readonly disabled: boolean;
}) {
  const worktreeItem = (
    <ToggleGroupItem value="worktree" disabled={disabled || !worktreeAllowed}>
      New worktree
    </ToggleGroupItem>
  );
  return (
    <ToggleGroup
      aria-label="Workspace"
      variant="outline"
      size="sm"
      spacing={0}
      value={[value]}
      onValueChange={(next) => {
        // Pressing the item that is on would leave none; one is always picked.
        if (next[0] === "here" || next[0] === "worktree") {
          onChange(next[0]);
        }
      }}
    >
      <ToggleGroupItem value="here" disabled={disabled}>
        This workspace
      </ToggleGroupItem>
      {worktreeAllowed ? (
        worktreeItem
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>{worktreeItem}</TooltipTrigger>
          <TooltipContent>{NOT_A_REPOSITORY}</TooltipContent>
        </Tooltip>
      )}
    </ToggleGroup>
  );
}

function BranchOffDialog({
  request,
  source,
  onClose,
}: {
  readonly request: BranchOffRequest;
  readonly source: ThreadSummary;
  readonly onClose: () => void;
}) {
  const [title, setTitle] = React.useState(() => forkTitle(source.title));
  const [workspace, setWorkspace] = React.useState<Workspace>("here");
  const worktreeAllowed = useWorktreeAllowed(source.projectId);
  const { here, inWorktree, creating, worktree } = useBranchOff(request, source, {
    title,
    onOpened: onClose,
  });
  const flow = worktree.state;
  const busy = creating || flow.step !== "idle";
  const working = creating || (flow.step !== "idle" && flow.step !== "failed");
  const canSubmit = !busy && title.trim().length > 0;

  const submit = () => {
    if (canSubmit) {
      void (workspace === "worktree" && worktreeAllowed ? inWorktree() : here());
    }
  };

  const where =
    source.worktree === undefined
      ? "the project's folder"
      : `the worktree ${source.worktree.branch}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fork thread</DialogTitle>
          <DialogDescription>
            {request.throughItemId === undefined
              ? "A new thread starts with this thread's whole conversation as context."
              : "A new thread starts with this thread's conversation up to and including this message's turn as context."}{" "}
            The original thread is not changed.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fork-title">Title</Label>
            <Input
              id="fork-title"
              value={title}
              autoFocus
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Workspace</Label>
            <WorkspacePicker
              value={workspace}
              onChange={setWorkspace}
              worktreeAllowed={worktreeAllowed}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              {workspace === "worktree" && worktreeAllowed
                ? `A branch and folder of its own, cut from ${source.worktree?.branch ?? "the default branch"}; the project's setup script runs there first.`
                : `Works in ${where}, beside this thread.`}
            </p>
          </div>
          <WorktreeSetupPanel
            state={flow}
            liveOutput={worktree.liveOutput}
            onStop={worktree.stop}
            onStartAnyway={async () => {
              if (flow.step === "failed") {
                await worktree.startAnyway(flow.worktree);
              }
            }}
            onDiscard={async () => {
              if (flow.step === "failed") {
                await worktree.discard(flow.worktree);
              }
            }}
          />
          <DialogActions>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {working ? <Spinner variant="bold" /> : null}
              Fork
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The one fork dialog, for whichever thread asked last; gone with its source. */
export function BranchOffHost() {
  const [request, setRequest] = useBranchOffRequest();
  const threads = useThreadList();
  const source =
    request === null ? undefined : threads.find((thread) => thread.threadId === request.threadId);
  if (request === null || source === undefined) {
    return null;
  }
  return (
    <BranchOffDialog
      key={request.key}
      request={request}
      source={source}
      onClose={() => setRequest(null)}
    />
  );
}
