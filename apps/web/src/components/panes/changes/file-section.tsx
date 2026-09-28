/**
 * One file of the Changes list: a compact row that sticks to the top while
 * its patch scrolls under it, and the patch itself once the row is opened. A
 * closed file keeps nothing mounted, so a long list of closed rows costs no
 * highlighting at all.
 *
 * The checkbox at the row's end marks the file viewed, which also closes it;
 * a viewed file's name dims, so what is left to read stands out. The "…"
 * menu after it holds the file's own actions (`./file-actions`), and a
 * right-click anywhere on the row opens the same entries.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@poseidon/ui/components/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { workspacePath } from "@/components/open-in/file-menu";
import { FileContextItems } from "@/components/open-in/file-menu-items";
import { InlineDiff } from "@/components/timeline/diff-pool";
import { cn } from "@/lib/utils";
import type { DiffStyle } from "@/state/ui";

import { FileActions } from "./file-actions";

import { type HoneyIcon, ChevronRight, Edit, FileAdd, FileRemove } from "@honeyicons/react";

const KIND_ICON: Record<GitDiffFile["kind"], HoneyIcon> = {
  create: FileAdd,
  edit: Edit,
  delete: FileRemove,
};

/** `+12 −3`, each side only when it is not zero. */
export function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) {
    return null;
  }
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
      {additions > 0 ? <span className="text-added">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-removed">−{deletions}</span> : null}
    </span>
  );
}

/** A path as a muted directory and a bright file name, the name never cut; all muted once viewed. */
function FilePath({ path, viewed }: { path: string; viewed: boolean }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 font-mono text-xs" title={path}>
      {slash === -1 ? null : (
        <span className="min-w-0 truncate text-muted-foreground">{path.slice(0, slash + 1)}</span>
      )}
      <span className={cn("shrink-0", viewed ? "text-muted-foreground" : "text-foreground")}>
        {path.slice(slash + 1)}
      </span>
    </span>
  );
}

export function FileSection({
  threadId,
  file,
  prefix,
  open,
  onOpenChange,
  viewed,
  onViewedChange,
  diffStyle,
}: {
  threadId: string;
  file: GitDiffFile;
  /** Where the workspace root sits in the repository (`GitDiff.prefix`). */
  prefix: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewed: boolean;
  onViewedChange: (viewed: boolean) => void;
  diffStyle: DiffStyle;
}) {
  const Glyph = KIND_ICON[file.kind];
  const expandable = file.diff !== "";
  // A deleted file is gone from the workspace: its menu only copies or adds to the chat.
  const exists = file.kind !== "delete";
  // git names the file from the repository's top level; the menu works from the root.
  const inside = workspacePath(file.path, prefix);
  const menu = { path: inside ?? file.path, exists, inWorkspace: inside !== null };
  return (
    <section>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div className="sticky top-0 z-10 flex h-7 items-center gap-1.5 border-b border-border bg-sidebar pr-1 hover:bg-hover" />
          }
        >
          <button
            type="button"
            disabled={!expandable}
            aria-expanded={expandable ? open : undefined}
            onClick={() => onOpenChange(!open)}
            className="flex h-full min-w-0 flex-1 items-center gap-2 py-1 pr-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset enabled:cursor-pointer"
          >
            <ChevronRight
              variant="bold"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
                open && expandable && "rotate-90",
                !expandable && "invisible",
              )}
            />
            <Glyph variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
            {file.oldPath === undefined ? (
              <FilePath path={file.path} viewed={viewed} />
            ) : (
              <span className="flex min-w-0 flex-1 gap-1 font-mono text-xs">
                <span className="min-w-0 truncate text-muted-foreground">{file.oldPath} →</span>
                <FilePath path={file.path} viewed={viewed} />
              </span>
            )}
            <LineCounts additions={file.additions} deletions={file.deletions} />
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Checkbox
                  aria-label={`Viewed ${file.path}`}
                  checked={viewed}
                  onCheckedChange={(checked) => onViewedChange(checked)}
                />
              }
            />
            <TooltipContent>{viewed ? "Viewed" : "Mark as viewed"}</TooltipContent>
          </Tooltip>
          <FileActions threadId={threadId} {...menu} />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <FileContextItems {...menu} chatId={threadId} />
        </ContextMenuContent>
      </ContextMenu>
      {open && expandable ? (
        <div className="border-b border-border">
          <InlineDiff patch={file.diff} diffStyle={diffStyle} className="rounded-none" />
        </div>
      ) : null}
    </section>
  );
}
