/**
 * The file tree in a narrow dock: an icon button in the summary line that
 * opens the same `FileTree` in a popover. Picking a file closes it, and the
 * list scrolls to that file as it would from the tree beside the diffs.
 */

import { Button } from "@poseidon/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@poseidon/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import { FileTree } from "./file-tree-view";
import { FolderTree } from "@honeyicons/react";

export function FileJumpMenu({ onSelect, ...tree }: React.ComponentProps<typeof FileTree>) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Changed files" />
              }
            />
          }
        >
          <FolderTree variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Changed files</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="max-h-96">
        <FileTree
          {...tree}
          onSelect={(path) => {
            setOpen(false);
            onSelect(path);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
