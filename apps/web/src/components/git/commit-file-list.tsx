/**
 * The commit dialog's file list: every path `git.status` reports — untracked
 * files included — with a checkbox each, all ticked until the user unticks
 * them. An untracked file is not always work the user wants committed (a
 * scratch file, a local note), which is why it is listed and can be left out.
 * Poseidon's own hook config never shows up here: the connector keeps it in
 * the repository's `info/exclude` while a session holds it.
 *
 * Each row shows the status letter and the path, cut in the middle so the
 * file name stays; its tooltip carries the whole path (`old → new` for a
 * rename). A select-all box above says how many are ticked, and the list
 * scrolls past a fixed height.
 */

import { Checkbox } from "@poseidon/ui/components/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { GitFileChange } from "@poseidon/contracts/rpc";

import { middleTruncate, selectAllState, statusLetter } from "./commit-picker";

/** Characters of a path a row shows before it cuts the middle out. */
const PATH_WIDTH = 60;

export function CommitFileList({
  files,
  excluded,
  onToggle,
  onToggleAll,
}: {
  readonly files: ReadonlyArray<GitFileChange>;
  readonly excluded: ReadonlySet<string>;
  readonly onToggle: (path: string, ticked: boolean) => void;
  readonly onToggleAll: (ticked: boolean) => void;
}) {
  const ticked = files.filter((file) => !excluded.has(file.path)).length;
  const all = selectAllState(ticked, files.length);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="flex h-7 items-center gap-2 px-2 text-sm font-medium">
        <Checkbox
          aria-label="Select all files"
          checked={all === "checked"}
          indeterminate={all === "indeterminate"}
          onCheckedChange={(checked) => onToggleAll(checked)}
        />
        <span>{`${ticked} of ${files.length} ${files.length === 1 ? "file" : "files"}`}</span>
      </label>
      <ul className="flex max-h-64 flex-col overflow-y-auto rounded-lg border">
        {files.map((file) => {
          const full = file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`;
          return (
            <li key={file.path}>
              <label className="flex h-7 items-center gap-2 px-2 text-sm hover:bg-hover">
                <Checkbox
                  aria-label={file.path}
                  checked={!excluded.has(file.path)}
                  onCheckedChange={(checked) => onToggle(file.path, checked)}
                />
                <span className="w-3 shrink-0 font-mono text-xs text-muted-foreground">
                  {statusLetter(file.status)}
                </span>
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 truncate font-mono text-xs" />}>
                    {middleTruncate(file.path, PATH_WIDTH)}
                  </TooltipTrigger>
                  <TooltipContent>{full}</TooltipContent>
                </Tooltip>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
