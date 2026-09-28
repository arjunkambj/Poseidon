/**
 * The Changes pane's changed-file tree: a filter over a WAI-ARIA tree of the
 * comparison's folders and files (the rules in `./file-tree`).
 *
 * Folders fold; each file shows its status letter, name, `+`/`−` counts and a
 * tick once viewed. One row is in the tab order at a time: the arrows move
 * it, Home and End jump, Left and Right fold and unfold, and Enter or a click
 * on a file hands it to `onSelect`, which is how the list scrolls to it. The
 * tree only lists: nothing opens a patch until the user picks a file.
 *
 * What is folded and the filter are the thread's own (`useChangesTreeState`),
 * so they outlive the dock closing. While a filter is typed every folder left
 * holds a match and shows open; what the user folds then lasts until the
 * filter changes.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import { Input } from "@poseidon/ui/components/input";
import * as React from "react";

import { PaneMessage } from "@/components/panes/files/pane-message";
import { cn } from "@/lib/utils";
import { useChangesTreeState } from "@/state/changes-view";

import { LineCounts } from "./file-section";
import {
  buildFileTree,
  filterTree,
  moveFocus,
  statusLetter,
  visibleRows,
  type TreeFile,
  type TreeRow,
} from "./file-tree";
import { Check, ChevronRight, Folder, FolderOpen, Search } from "@honeyicons/react";

const NO_FOLDS: ReadonlySet<string> = new Set();

/** A row's identity across renders: folders and files can share a path prefix, never a key. */
const rowKey = (row: TreeRow): string => `${row.node.type}:${row.node.path}`;

const LETTER_TONE: Record<ReturnType<typeof statusLetter>, string> = {
  A: "text-added",
  D: "text-removed",
  M: "text-muted-foreground",
  R: "text-muted-foreground",
};

function FileRowBody({ file, viewed }: { file: TreeFile; viewed: boolean }) {
  const letter = statusLetter(file);
  return (
    <>
      <span className={cn("w-3 shrink-0 text-center font-mono text-xs", LETTER_TONE[letter])}>
        {letter}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-xs",
          viewed ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {file.name}
      </span>
      <LineCounts additions={file.additions} deletions={file.deletions} />
      {viewed ? (
        <Check
          variant="bold"
          aria-label="Viewed"
          className="size-3.5 shrink-0 text-foreground/85"
        />
      ) : null}
    </>
  );
}

export function FileTree({
  threadId,
  files,
  viewed,
  selected,
  onSelect,
  className,
}: {
  threadId: string;
  files: ReadonlyArray<GitDiffFile>;
  /** The paths marked viewed for the patch they have now. */
  viewed: ReadonlySet<string>;
  /** The file the list last moved to or the user last picked. */
  selected: string | null;
  onSelect: (path: string) => void;
  className?: string;
}) {
  const { collapsed, filter, setFolderOpen, setFilter } = useChangesTreeState(threadId);
  const tree = React.useMemo(() => buildFileTree(files), [files]);
  const shown = React.useMemo(() => filterTree(tree, filter), [tree, filter]);

  // Folds made while filtering belong to that filter, and start over with the next.
  const [filterFolds, setFilterFolds] = React.useState({ filter, collapsed: NO_FOLDS });
  const filtering = filter.trim() !== "";
  const folds = !filtering
    ? collapsed
    : filterFolds.filter === filter
      ? filterFolds.collapsed
      : NO_FOLDS;
  const rows = React.useMemo(() => visibleRows(shown, folds), [shown, folds]);
  const setOpen = (path: string, open: boolean) => {
    if (!filtering) {
      setFolderOpen(path, open);
      return;
    }
    const next = new Set(folds);
    if (open) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setFilterFolds({ filter, collapsed: next });
  };

  // The roving tab stop, by key so a refresh that reorders rows keeps it.
  const [focusKey, setFocusKey] = React.useState<string | null>(null);
  const focusIndex = rows.findIndex((row) => rowKey(row) === focusKey);
  const tabStop = focusIndex === -1 ? 0 : focusIndex;
  const rowRefs = React.useRef(new Map<string, HTMLLIElement>());

  const focusRow = (index: number) => {
    const row = rows[index];
    if (row === undefined) {
      return;
    }
    const key = rowKey(row);
    setFocusKey(key);
    rowRefs.current.get(key)?.focus();
  };

  const activate = (row: TreeRow) => {
    setFocusKey(rowKey(row));
    if (row.node.type === "folder") {
      setOpen(row.node.path, !row.expanded);
    } else {
      onSelect(row.node.path);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    // A chord (Alt+Down steps the diffs) is the pane's, not the tree's.
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    const row = rows[focusIndex];
    if ((event.key === "Enter" || event.key === " ") && row !== undefined) {
      event.preventDefault();
      activate(row);
      return;
    }
    const move = moveFocus(rows, focusIndex, event.key);
    if (move === null) {
      return;
    }
    event.preventDefault();
    if (move.collapse !== undefined) {
      setOpen(move.collapse, false);
    }
    if (move.expand !== undefined) {
      setOpen(move.expand, true);
    }
    focusRow(move.focus);
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="shrink-0 px-2 py-1.5">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && !event.altKey && rows.length > 0) {
              event.preventDefault();
              focusRow(tabStop);
            }
          }}
          placeholder="Filter files"
          aria-label="Filter files"
        />
      </div>
      {rows.length === 0 ? (
        <PaneMessage icon={Search} text="No files match" />
      ) : (
        <ul
          role="tree"
          aria-label="Changed files"
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto pb-1"
        >
          {rows.map((row, index) => {
            const key = rowKey(row);
            const node = row.node;
            const Glyph = row.expanded ? FolderOpen : Folder;
            return (
              <li
                key={key}
                ref={(element) => {
                  if (element === null) {
                    rowRefs.current.delete(key);
                  } else {
                    rowRefs.current.set(key, element);
                  }
                }}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={node.type === "folder" ? row.expanded : undefined}
                aria-selected={node.type === "file" && node.path === selected}
                tabIndex={index === tabStop ? 0 : -1}
                title={node.path}
                onClick={() => activate(row)}
                onFocus={() => setFocusKey(key)}
                // Computed indent: 8px, then 12px per level.
                style={{ "--tree-indent": `${8 + row.depth * 12}px` } as React.CSSProperties}
                className="flex h-7 cursor-pointer items-center gap-1.5 py-1 pr-2 pl-(--tree-indent) outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-selected:bg-muted"
              >
                {node.type === "folder" ? (
                  <>
                    <ChevronRight
                      variant="bold"
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
                        row.expanded && "rotate-90",
                      )}
                    />
                    <Glyph variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                      {node.name}
                    </span>
                  </>
                ) : (
                  <FileRowBody file={node} viewed={viewed.has(node.path)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
