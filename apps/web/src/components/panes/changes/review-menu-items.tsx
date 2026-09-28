/**
 * A Changes file's own menu entries, after the shared file menu
 * (`@/components/open-in/file-menu-items`) in both its "…" menu and its
 * right-click menu: `ReviewDropdownItems` and `ReviewContextItems` render the
 * same list, only the menu parts differ.
 *
 * "Copy diff" copies the file's patch as git printed it, through `copyText`
 * like every other copy; a file with no patch (binary, mode-only) has nothing
 * to copy, so its section is left out, separator and all.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import { ContextMenuItem, ContextMenuSeparator } from "@poseidon/ui/components/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@poseidon/ui/components/dropdown-menu";
import type * as React from "react";

import { copyText } from "@/lib/copy-path";

import { GitDiff } from "@honeyicons/react";

interface MenuParts {
  readonly Item: React.ComponentType<{ onClick?: () => void; children?: React.ReactNode }>;
  readonly Separator: React.ComponentType;
}

const DROPDOWN: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };
const CONTEXT: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

interface ReviewMenuProps {
  readonly file: Pick<GitDiffFile, "path" | "diff">;
}

type ReviewMenuEntry = { readonly kind: "copy-diff"; readonly diff: string };

/** The entries a file's review section offers, in order; empty for none. */
const reviewMenuEntries = (file: ReviewMenuProps["file"]): ReadonlyArray<ReviewMenuEntry> =>
  file.diff === "" ? [] : [{ kind: "copy-diff", diff: file.diff }];

function ReviewMenuItems({ parts, file }: ReviewMenuProps & { parts: MenuParts }) {
  const entries = reviewMenuEntries(file);
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
