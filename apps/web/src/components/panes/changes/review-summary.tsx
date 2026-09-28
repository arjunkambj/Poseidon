/**
 * The line over a comparison's files (`ReviewList`): how many files, how many
 * lines, how many the user has viewed, and the toggle that opens or closes
 * them all at once.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { LineCounts } from "./file-section";
import { UnfoldLess, UnfoldMore } from "@honeyicons/react";

/**
 * The line over the files: `3 files · +20 −4 · 1 viewed`, and the toggle that
 * opens every file or closes them all.
 */
export function ReviewSummary({
  files,
  viewed,
  allOpen,
  onAllOpenChange,
}: {
  files: ReadonlyArray<GitDiffFile>;
  viewed: number;
  allOpen: boolean;
  onAllOpenChange: (open: boolean) => void;
}) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const label = allOpen ? "Collapse all files" : "Expand all files";
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border pr-2 pl-3 type-micro text-muted-foreground">
      <span className="shrink-0">
        {files.length} {files.length === 1 ? "file" : "files"}
      </span>
      {additions > 0 || deletions > 0 ? (
        <>
          <span aria-hidden>·</span>
          <LineCounts additions={additions} deletions={deletions} />
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span className="shrink-0">{viewed} viewed</span>
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              disabled={!allOpen && files.every((file) => file.diff === "")}
              onClick={() => onAllOpenChange(!allOpen)}
            />
          }
        >
          {allOpen ? <UnfoldLess variant="bold" /> : <UnfoldMore variant="bold" />}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
