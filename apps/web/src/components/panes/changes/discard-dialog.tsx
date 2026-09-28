/**
 * Discarding changes deletes work, so it never happens on a single click: a
 * file's "Discard changes…" entry, or the summary line's "Discard all", opens
 * the shared `ConfirmDialog`, whose text says exactly what is lost in the
 * comparison on screen (`discardDescription`, `discardAllDescription`). Only
 * its Discard button calls `git.discard`, with the scope's base
 * (`useReviewScope`).
 *
 * The call is a one-shot that refreshes every git read of the project when it
 * lands, so the file leaves the list by itself. A refusal — an unsafe path, a
 * turn that started meanwhile — surfaces as a toast with the server's reason.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as Exit from "effect/Exit";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { describeExitError } from "@/lib/app-runtime";

import {
  canDiscardAll,
  discardAllDescription,
  discardDescription,
  discardInput,
  type DiscardTarget,
} from "./discard";
import { useGitReview } from "./git-atoms";
import { useReviewScope } from "./review-scope";

import { Trash } from "@honeyicons/react";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The confirmation for one target; renders nothing outside a review scope. */
export function DiscardDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: DiscardTarget;
}) {
  const scope = useReviewScope();
  const { discard } = useGitReview();
  if (scope === null) {
    return null;
  }
  const all = target.kind === "all";
  const run = async () => {
    const exit = await discard(discardInput(scope, scope.base, target));
    if (Exit.isSuccess(exit)) {
      toast.success(
        all
          ? "Discarded every uncommitted change"
          : `Discarded the changes to ${fileName(target.file.path)}`,
      );
      return;
    }
    toast.error(
      `Discard failed: ${describeExitError(exit, "the changes could not be discarded.")}`,
    );
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        all
          ? "Discard all uncommitted changes?"
          : `Discard changes to ${fileName(target.file.path)}?`
      }
      description={
        all ? discardAllDescription(target.files) : discardDescription(target.file, scope)
      }
      confirmLabel={all ? "Discard all" : "Discard"}
      onConfirm={() => void run()}
    />
  );
}

/**
 * The summary line's "Discard all", only in the Uncommitted scope; disabled
 * with the reason while discarding cannot start.
 */
export function DiscardAllButton({ files }: { files: ReadonlyArray<GitDiffFile> }) {
  const scope = useReviewScope();
  const [open, setOpen] = React.useState(false);
  if (scope === null || !canDiscardAll(scope.kind)) {
    return null;
  }
  const reason = scope.discardDisabledReason;
  return (
    <>
      <Tooltip>
        {/* A disabled button takes no pointer events: the wrapper keeps the reason reachable. */}
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Discard all changes"
            disabled={reason !== null}
            onClick={() => setOpen(true)}
          >
            <Trash variant="bold" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{reason ?? "Discard all changes"}</TooltipContent>
      </Tooltip>
      <DiscardDialog open={open} onOpenChange={setOpen} target={{ kind: "all", files }} />
    </>
  );
}
