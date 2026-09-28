/**
 * A Changes file row's review actions: discard its change.
 *
 * `useFileReviewActions` gives the row its menu entries (`actions`, for the
 * "…" menu and the right-click menu alike) and the dialog they open
 * (`overlays`), which the row renders beside its menus — a menu's content
 * unmounts as it closes, so the dialog cannot live inside it.
 *
 * Outside a review scope (`useReviewScope` is `null`) the row gets none of
 * them.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import * as React from "react";

import { DiscardDialog } from "./discard-dialog";
import type { ReviewMenuActions } from "./review-menu-items";
import { useReviewScope } from "./review-scope";

export function useFileReviewActions(file: GitDiffFile): {
  actions: ReviewMenuActions | undefined;
  overlays: React.ReactNode;
} {
  const scope = useReviewScope();
  const [discardOpen, setDiscardOpen] = React.useState(false);
  if (scope === null) {
    return { actions: undefined, overlays: null };
  }
  return {
    actions: {
      onDiscard: () => setDiscardOpen(true),
      discardDisabledReason: scope.discardDisabledReason,
    },
    overlays: (
      <DiscardDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        target={{ kind: "file", file }}
      />
    ),
  };
}
