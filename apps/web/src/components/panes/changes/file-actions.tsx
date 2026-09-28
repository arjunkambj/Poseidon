/**
 * The "…" menu at the end of a Changes file row: the file's menu
 * (`@/components/open-in/file-menu-items`) — open it in the Files tab or an
 * editor, reveal it in the file manager, copy its path, or add a reference to
 * it to the thread's draft. The same entries open on a right-click of the row.
 * Nothing here touches the worktree: reverting a file is not an action the
 * pane offers.
 */

import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { FileDropdownItems } from "@/components/open-in/file-menu-items";

import { MoreHorizontal } from "@honeyicons/react";

export function FileActions({
  threadId,
  path,
  exists,
}: {
  threadId: string;
  path: string;
  /** `false` for a deleted file, whose menu only copies or adds to the chat. */
  exists: boolean;
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
        <FileDropdownItems path={path} exists={exists} chatId={threadId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
