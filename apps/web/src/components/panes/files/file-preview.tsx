/**
 * Read-only preview of one workspace file, a page at a time.
 *
 * `files.read` answers a line window plus the file's real line count, so the
 * footer pages through the whole file rather than showing one truncated head.
 * Everything the server cannot express — an empty file, a window past the end,
 * bytes that are not text — is decided in `./preview` and tested there.
 *
 * The page is a line *offset*, not a page number: the server may answer a
 * window short when its character cap bites, so Next resumes at the last line
 * it actually sent and Previous walks back over the offsets already visited.
 *
 * The page — the offset and the offsets behind it — is the parent's, kept in
 * the thread's Files view (`./files-view`) with the scroll, so leaving the
 * dock tab and coming back reopens the file where it was read. The parent
 * mounts this with `key={path}`, so opening another file starts at the top
 * instead of inheriting this file's position.
 *
 * Opened at a line (a file chip in the timeline, `revealedPreview`), the page
 * is the one that shows it (`offsetForLine`) and the line's row is marked.
 * While the view's `reveal` is set, the row is scrolled into view — or the
 * page to its top, for a file opened without a line — as soon as the page
 * arrives, and `onRevealed` clears it, so coming back to the tab later keeps
 * the reader's own scroll instead.
 *
 * A code file shown whole and small enough (`previewHighlight`) is syntax
 * highlighted by the timeline's worker pool (`./highlighted-page`); anything
 * else — a paged, capped or large file, an unknown name, no pool — is the
 * plain line table, and the footer says when size alone kept the colours off.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useWorkerPool } from "@pierre/diffs/react";
import type { FileQuery } from "@poseidon/client-runtime/fileAtoms";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { FileContent } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { scrollWithin } from "@/lib/scroll-within";
import { cn } from "@/lib/utils";

import { useFileAtoms } from "./file-atoms";
import type { FilesPreviewView, useKeptScroll } from "./files-view";
import { HighlightedPage } from "./highlighted-page";
import { PaneMessage } from "./pane-message";
import {
  looksBinary,
  PAGE_LINES,
  pagePosition,
  previewHighlight,
  previewLines,
  tooLargeToHighlight,
  windowFor,
} from "./preview";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  File as FileIcon,
  Repeat,
  Spinner,
  WifiOff,
} from "@honeyicons/react";

function LineTable({
  offset,
  content,
  scroll,
  markedLine,
  reveal,
  onRevealed,
}: {
  offset: number;
  content: FileContent;
  scroll: ReturnType<typeof useKeptScroll>;
  markedLine: number | undefined;
  reveal: boolean;
  onRevealed: () => void;
}) {
  const lines = previewLines(offset, content);
  const box = React.useRef<HTMLDivElement | null>(null);
  const marked = React.useRef<HTMLTableRowElement>(null);
  const keep = scroll.ref;
  const boxRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      box.current = element;
      keep(element);
    },
    [keep],
  );
  // Only the table's own box scrolls (`scrollWithin`): a chip that opened the
  // dock reveals while the dock still animates open and clips its content.
  React.useEffect(() => {
    if (!reveal) return;
    const scroller = box.current;
    if (scroller !== null) {
      if (marked.current === null) {
        scroller.scrollTop = 0;
      } else {
        scrollWithin(scroller, marked.current, "center");
      }
    }
    onRevealed();
  }, [reveal, markedLine, onRevealed]);
  return (
    <div ref={boxRef} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse font-mono text-xs">
        <tbody>
          {lines.map((line) => (
            <tr
              key={line.number}
              ref={line.number === markedLine ? marked : undefined}
              aria-current={line.number === markedLine ? "location" : undefined}
              className={cn("align-top", line.number === markedLine && "bg-hover")}
            >
              <td className="w-0 select-none pr-3 pl-2 text-right tabular-nums text-muted-foreground">
                {line.number}
              </td>
              <td className="whitespace-pre pr-2 text-foreground">
                {line.text === "" ? " " : line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FilePreview({
  projectId,
  threadId,
  path,
  connected,
  page,
  onPageChange,
  onRevealed,
  scroll,
}: {
  readonly projectId: ProjectId;
  /** `null` reads the project's own folder, as the New task page's Files tab does. */
  readonly threadId: ThreadId | null;
  readonly path: string;
  readonly connected: boolean;
  /**
   * The page shown, and the offsets Next came from, so Previous lands back on
   * the exact windows the reader saw — a page the server cut short is not
   * PAGE_LINES wide.
   */
  readonly page: Pick<FilesPreviewView, "offset" | "visited" | "line" | "reveal">;
  readonly onPageChange: (offset: number, visited: ReadonlyArray<number>) => void;
  /** Called once the page has scrolled to the line it was opened at. */
  readonly onRevealed: () => void;
  readonly scroll: ReturnType<typeof useKeptScroll>;
}) {
  const atoms = useFileAtoms();
  const { offset, visited } = page;
  const atom = atoms.fileContentAtom({
    projectId,
    threadId: threadId ?? undefined,
    path,
    ...windowFor(offset),
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const pool = useWorkerPool();

  const query: FileQuery<FileContent> | "broken" | null = AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result)
      ? "broken"
      : null;

  const retry = (
    <Button type="button" variant="ghost" size="sm" onClick={refresh}>
      <Repeat variant="bold" />
      Try again
    </Button>
  );

  if (query === null) {
    return connected ? (
      <PaneMessage icon={Spinner} text="Loading file…" detail={path} />
    ) : (
      <PaneMessage icon={WifiOff} text="Not connected to the server." />
    );
  }
  if (query === "broken") {
    return (
      <PaneMessage
        icon={AlertTriangle}
        text="Could not read this file."
        detail={path}
        action={retry}
      />
    );
  }
  if (query._tag === "error") {
    return <PaneMessage icon={AlertTriangle} text={query.message} detail={path} action={retry} />;
  }

  const content = query.value;
  if (looksBinary(content.text)) {
    return (
      <PaneMessage
        icon={FileIcon}
        text="This looks like a binary file, so there is nothing to show."
        detail={path}
      />
    );
  }

  const position = pagePosition(offset, content);
  if (position.firstLine === 0 && !position.hasPrevious) {
    return <PaneMessage icon={FileIcon} text="This file is empty." detail={path} />;
  }

  const highlight = pool === undefined ? null : previewHighlight(path, content, offset);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {highlight !== null ? (
        <HighlightedPage
          path={path}
          content={content}
          language={highlight.language}
          scroll={scroll}
          markedLine={page.line}
          reveal={page.reveal === true}
          onRevealed={onRevealed}
        />
      ) : (
        <LineTable
          offset={offset}
          content={content}
          scroll={scroll}
          markedLine={page.line}
          reveal={page.reveal === true}
          onRevealed={onRevealed}
        />
      )}
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-2 type-micro text-muted-foreground">
        <span className="min-w-0 truncate">{position.label}</span>
        {position.capped || (content.truncated && !position.hasNext) ? (
          <span className="shrink-0">· capped by the server</span>
        ) : null}
        {tooLargeToHighlight(path, content, offset) ? (
          <span className="min-w-0 truncate">· plain text (too large to highlight)</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Previous page"
                  disabled={!position.hasPrevious}
                  onClick={() =>
                    onPageChange(
                      visited.at(-1) ?? Math.max(0, offset - PAGE_LINES),
                      visited.slice(0, -1),
                    )
                  }
                />
              }
            >
              <ChevronUp variant="bold" />
            </TooltipTrigger>
            <TooltipContent>Previous page</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Next page"
                  disabled={!position.hasNext}
                  onClick={() => onPageChange(position.nextOffset, [...visited, offset])}
                />
              }
            >
              <ChevronDown variant="bold" />
            </TooltipTrigger>
            <TooltipContent>Next page</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
