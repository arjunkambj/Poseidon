/**
 * The "…" menu at the end of a Changes file row: the file's menu
 * (`@/components/open-in/file-menu-items`) — open it in the Files tab or an
 * editor, reveal it in the file manager, copy its path, or add a reference to
 * it to the thread's draft — then the review's own entries
 * (`./review-menu-items`): copy the file's diff, and discard its change
 * behind a confirmation. The same entries open on a right-click of
 * the row.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { FileDropdownItems } from "@/components/open-in/file-menu-items";

import { ReviewDropdownItems, type ReviewMenuActions } from "./review-menu-items";

import { MoreHorizontal } from "@honeyicons/react";

export function FileActions({
  threadId,
  path,
  exists,
  inWorkspace,
  file,
  actions,
}: {
  threadId: string;
  /** Relative to the workspace root, or to the repository when not `inWorkspace`. */
  path: string;
  /** `false` for a deleted file, whose menu only copies or adds to the chat. */
  exists: boolean;
  inWorkspace: boolean;
  /** The file as the diff lists it, for the review's own entries. */
  file: Pick<GitDiffFile, "path" | "diff">;
  /** Discard, when the row is in a review scope. */
  actions?: ReviewMenuActions | undefined;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${path}`} />}
            />
          }
        >
          <MoreHorizontal variant="bold" />
        </TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <FileDropdownItems
          path={path}
          exists={exists}
          inWorkspace={inWorkspace}
          chatId={threadId}
        />
        <ReviewDropdownItems file={file} actions={actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
