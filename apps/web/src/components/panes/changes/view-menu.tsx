/**
 * The Changes toolbar's View menu: how the diffs are drawn, kept in the
 * settings document (`diffView`) for every thread. "Ignore whitespace" asks
 * git again with `-w`; "Wrap lines" wraps long lines instead of scrolling
 * them sideways. Both start off.
 */

import type { DiffViewSettings } from "@poseidon/contracts/settings";
import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { SlidersHorizontal } from "@honeyicons/react";

export function ViewMenu({
  diffView,
  onDiffViewChange,
}: {
  diffView: DiffViewSettings;
  onDiffViewChange: (next: Partial<DiffViewSettings>) => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="ghost" size="icon-sm" aria-label="View options" />
              }
            />
          }
        >
          <SlidersHorizontal variant="bold" />
        </TooltipTrigger>
        <TooltipContent>View options</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuCheckboxItem
          checked={diffView.ignoreWhitespace}
          onCheckedChange={(checked) => onDiffViewChange({ ignoreWhitespace: checked })}
        >
          Ignore whitespace
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={diffView.wrapLines}
          onCheckedChange={(checked) => onDiffViewChange({ wrapLines: checked })}
        >
          Wrap lines
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
