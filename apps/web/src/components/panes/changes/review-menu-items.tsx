/**
 * A Changes file's own menu entries, after the shared file menu
 * (`@/components/open-in/file-menu-items`) in both its "…" menu and its
 * right-click menu: `ReviewDropdownItems` and `ReviewContextItems` render the
 * same list, only the menu parts differ.
 *
 * "Copy diff" copies the file's patch as git printed it, through `copyText`
 * like every other copy; a file with no patch (binary, mode-only) has nothing
 * to copy. "Show blame" opens the file's blame popover, for a file that still
 * exists in the workspace. "Discard changes…" opens the discard confirmation,
 * and is disabled with its reason on hover while discarding cannot start. The
 * popover and the dialog are the row's own (`useFileReviewActions`), rendered
 * beside the menu, since a menu's content unmounts as it closes. A file with
 * none of these has no section, separator and all.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import { ContextMenuItem, ContextMenuSeparator } from "@poseidon/ui/components/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import { copyText } from "@/lib/copy-path";

import { GitCommit, GitDiff, Trash } from "@honeyicons/react";

interface MenuParts {
  readonly Item: React.ComponentType<{
    onClick?: () => void;
    disabled?: boolean;
    variant?: "default" | "destructive";
    children?: React.ReactNode;
  }>;
  readonly Separator: React.ComponentType;
}

const DROPDOWN: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };
const CONTEXT: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

/** The row's review actions; absent outside a review scope. */
export interface ReviewMenuActions {
  /** Opens the blame popover; absent for a file the workspace no longer has. */
  readonly onShowBlame?: (() => void) | undefined;
  readonly onDiscard: () => void;
  /** Non-null disables "Discard changes…" and says why on hover. */
  readonly discardDisabledReason: string | null;
}

interface ReviewMenuProps {
  readonly file: Pick<GitDiffFile, "path" | "diff">;
  readonly actions?: ReviewMenuActions | undefined;
}

type ReviewMenuEntry =
  | { readonly kind: "copy-diff"; readonly diff: string }
  | { readonly kind: "blame"; readonly onSelect: () => void }
  | {
      readonly kind: "discard";
      readonly onSelect: () => void;
      readonly disabledReason: string | null;
    };

/** The entries a file's review section offers, in order; empty for none. */
export const reviewMenuEntries = (
  file: ReviewMenuProps["file"],
  actions: ReviewMenuActions | undefined,
): ReadonlyArray<ReviewMenuEntry> => [
  ...(file.diff === "" ? [] : [{ kind: "copy-diff", diff: file.diff } as const]),
  ...(actions?.onShowBlame === undefined
    ? []
    : [{ kind: "blame", onSelect: actions.onShowBlame } as const]),
  ...(actions === undefined
    ? []
    : [
        {
          kind: "discard",
          onSelect: actions.onDiscard,
          disabledReason: actions.discardDisabledReason,
        } as const,
      ]),
];

function ReviewMenuItems({ parts, file, actions }: ReviewMenuProps & { parts: MenuParts }) {
  const entries = reviewMenuEntries(file, actions);
  if (entries.length === 0) {
    return null;
  }
  const item = (entry: ReviewMenuEntry) => {
    switch (entry.kind) {
      case "copy-diff":
        return (
          <parts.Item key={entry.kind} onClick={() => void copyText(entry.diff, "diff")}>
            <GitDiff variant="bold" />
            Copy diff
          </parts.Item>
        );
      case "blame":
        return (
          <parts.Item key={entry.kind} onClick={entry.onSelect}>
            <GitCommit variant="bold" />
            Show blame
          </parts.Item>
        );
      case "discard": {
        const item = (
          <parts.Item
            variant="destructive"
            disabled={entry.disabledReason !== null}
            onClick={entry.onSelect}
          >
            <Trash variant="bold" />
            Discard changes…
          </parts.Item>
        );
        return entry.disabledReason === null ? (
          <React.Fragment key={entry.kind}>{item}</React.Fragment>
        ) : (
          // A disabled item takes no pointer events: the wrapper keeps the reason reachable.
          <Tooltip key={entry.kind}>
            <TooltipTrigger render={<div />}>{item}</TooltipTrigger>
            <TooltipContent side="left">{entry.disabledReason}</TooltipContent>
          </Tooltip>
        );
      }
    }
  };
  return (
    <>
      <parts.Separator />
      {entries.map(item)}
    </>
  );
}

/** The entries as `DropdownMenu` items, for the "…" menu's content. */
export function ReviewDropdownItems(props: ReviewMenuProps) {
  return <ReviewMenuItems parts={DROPDOWN} {...props} />;
}

/** The entries as `ContextMenu` items, for the row's right-click menu. */
export function ReviewContextItems(props: ReviewMenuProps) {
  return <ReviewMenuItems parts={CONTEXT} {...props} />;
}
