/**
 * A Changes file row's review actions: discard its change and show its blame.
 *
 * `useFileReviewActions` gives the row its menu entries (`actions`, for the
 * "…" menu and the right-click menu alike), the line-number click the diff
 * takes for a one-line blame (`onLineNumberClick`), and the dialog and
 * popover those open (`overlays`), which the row renders beside its menus —
 * a menu's content unmounts as it closes, so they cannot live inside it.
 *
 * Outside a review scope (`useReviewScope` is `null`) the row gets none of
 * them. Blame needs the file in the workspace, so a deleted file has none;
 * the per-line one is offered only in Uncommitted and Branch, whose new side
 * is the working file, so the line numbers match what `git blame` reads.
 * Turn checkpoints are root commits with no history to blame.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import * as React from "react";

import type { DiffLineNumberClick } from "@/components/timeline/diff-pool";

import { BlamePopover, type BlameRequest } from "./blame-popover";
import { DiscardDialog } from "./discard-dialog";
import type { ReviewMenuActions } from "./review-menu-items";
import { useReviewScope } from "./review-scope";

export function useFileReviewActions(
  file: GitDiffFile,
  rowRef: React.RefObject<Element | null>,
): {
  actions: ReviewMenuActions | undefined;
  onLineNumberClick: ((click: DiffLineNumberClick) => void) | undefined;
  overlays: React.ReactNode;
} {
  const scope = useReviewScope();
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [blame, setBlame] = React.useState<BlameRequest | null>(null);
  if (scope === null) {
    return { actions: undefined, onLineNumberClick: undefined, overlays: null };
  }
  const blameable = file.kind !== "delete";
  const lineBlame = blameable && (scope.kind === "uncommitted" || scope.kind === "branch");
  return {
    actions: {
      onShowBlame: blameable ? () => setBlame({ kind: "file" }) : undefined,
      onDiscard: () => setDiscardOpen(true),
      discardDisabledReason: scope.discardDisabledReason,
    },
    onLineNumberClick: lineBlame
      ? (click) => {
          // Only the new side is the working file; a removed line has no blame there.
          if (click.side === "additions") {
            setBlame({ kind: "line", line: click.lineNumber, anchor: click.numberElement });
          }
        }
      : undefined,
    overlays: (
      <>
        <DiscardDialog
          open={discardOpen}
          onOpenChange={setDiscardOpen}
          target={{ kind: "file", file }}
        />
        {blameable ? (
          <BlamePopover
            where={scope}
            path={file.path}
            request={blame}
            onClose={() => setBlame(null)}
            fileAnchor={rowRef}
          />
        ) : null}
      </>
    ),
  };
}
