/**
 * A workspace file named in the timeline, as a chip: the file's icon, its name
 * (or its whole relative path, in a tool row) and the line it points at.
 * Only a path `files.stat` confirmed becomes one (`use-path-chips.ts`).
 *
 * Clicking opens the file in the thread's Files tab at that line, through
 * `useRequestFileReveal`. The context menu opens it too, and copies the path
 * relative to the workspace or in full. The tooltip names the whole relative
 * path, which the chip in a message shortens to its name.
 *
 * The chip keeps no state of its own beyond its menu, so a recycled row
 * cannot carry one file's chip over to another.
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@poseidon/ui/components/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { isCodeFile } from "@/components/timeline/code-fence";
import {
  baseName,
  type ConfirmedFile,
  type PathLink,
  positionLabel,
} from "@/components/timeline/path-links";
import { useTimelineThreadId } from "@/components/timeline/thread-context";
import { FindText } from "@/components/timeline/thread-find-context";
import { copyPath } from "@/lib/copy-path";
import { cn } from "@/lib/utils";
import { useRequestFileReveal } from "@/state/file-reveal";
import { Clipboard, Copy, File as FileIcon, FileCode, FolderOpen } from "@honeyicons/react";

export function FileChip({
  file,
  position = {},
  display = "name",
  className,
}: {
  readonly file: ConfirmedFile;
  readonly position?: Pick<PathLink, "line" | "column" | "endLine">;
  /** `name` in prose (with any parent folders it needs); `path` in a tool row. */
  readonly display?: "name" | "path";
  readonly className?: string;
}) {
  const threadId = useTimelineThreadId();
  const requestReveal = useRequestFileReveal();
  const where = positionLabel(position);
  const Icon = isCodeFile(file.relativePath) ? FileCode : FileIcon;
  const open = () => {
    if (threadId === null) return;
    requestReveal(threadId, {
      path: file.relativePath,
      ...(position.line === undefined ? {} : { line: position.line }),
    });
  };
  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Open ${file.relativePath}${where}`}
                  onClick={open}
                  className={cn(
                    "relative inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm bg-file-bg px-1 py-px align-bottom font-mono text-xs text-file outline-none select-none",
                    "hover:underline hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring",
                    className,
                  )}
                />
              }
            />
          }
        >
          <Icon variant="bold" className="size-3 shrink-0" />
          <span className="flex min-w-0">
            <span className="min-w-0 truncate">
              {display === "path" ? (
                <FindText text={file.relativePath} />
              ) : (
                <>
                  {file.suffix === undefined ? null : (
                    <span className="opacity-70">{file.suffix}</span>
                  )}
                  {baseName(file.relativePath)}
                </>
              )}
            </span>
            {where === "" ? null : <span className="shrink-0 opacity-70">{where}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {file.relativePath}
          {where}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onClick={open}>
          <FolderOpen variant="bold" />
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyPath(file.relativePath)}>
          <Copy variant="bold" />
          Copy relative path
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyPath(file.absolutePath)}>
          <Clipboard variant="bold" />
          Copy full path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
