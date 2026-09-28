/**
 * Discarding changes deletes work, so it never happens on a single click: a
 * file's "Discard changes…" entry opens
 * the shared `ConfirmDialog`, whose text says exactly what is lost in the
 * comparison on screen (`discardDescription`, `discardAllDescription`). Only
 * its Discard button calls `git.discard`, with the scope's base
 * (`useReviewScope`).
 *
 * The call is a one-shot that refreshes every git read of the project when it
 * lands, so the file leaves the list by itself. A refusal — an unsafe path, a
 * turn that started meanwhile — surfaces as a toast with the server's reason.
 */

import * as Exit from "effect/Exit";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { describeExitError } from "@/lib/app-runtime";

import {
  discardAllDescription,
  discardDescription,
  discardInput,
  type DiscardTarget,
} from "./discard";
import { useGitReview } from "./git-atoms";
import { useReviewScope } from "./review-scope";

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
