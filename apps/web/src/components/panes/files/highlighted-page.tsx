/**
 * A whole small file in the Files preview, syntax highlighted.
 *
 * `File` from `@pierre/diffs` draws it under the worker pool the root mounts
 * (`DiffWorkerPoolProvider`), the same pool and themes the timeline's code
 * blocks and diffs use, so Shiki tokenizes off the main thread and the page
 * follows light and dark. Only the page on screen is highlighted, and only
 * when `previewHighlight` says it is the whole file and small enough; the
 * parent renders the plain line table otherwise, and whenever there is no pool.
 *
 * The library draws into a shadow root, so the marked line is its
 * `selectedLines`, and the reveal finds the line's row (`data-line`, 1-based,
 * which is the file's own number since the page starts at line 1) inside that
 * root once the first render lands. The wrapping box scrolls both ways and
 * keeps the reader's scroll the way the plain table does; since the code is
 * not in the box when it mounts, the kept position is put back after that
 * first render too.
 */

import { File } from "@pierre/diffs/react";
import type { FileContent } from "@poseidon/contracts/rpc";
import * as React from "react";

import { useTheme } from "@/components/theme-provider";
import { scrollWithin } from "@/lib/scroll-within";

import type { useKeptScroll } from "./files-view";
import { previewCacheKey, previewFileOptions } from "./preview";

/** The code row of a 1-based line inside the rendered file, if it drew one. */
const lineRow = (host: HTMLElement, line: number): HTMLElement | null =>
  (host.shadowRoot ?? host).querySelector<HTMLElement>(`[data-line="${line}"]`);

export function HighlightedPage({
  path,
  content,
  language,
  scroll,
  markedLine,
  reveal,
  onRevealed,
}: {
  readonly path: string;
  readonly content: FileContent;
  readonly language: string;
  readonly scroll: ReturnType<typeof useKeptScroll>;
  readonly markedLine: number | undefined;
  readonly reveal: boolean;
  readonly onRevealed: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const themeType = resolvedTheme === "dark" ? "dark" : "light";
  const box = React.useRef<HTMLDivElement | null>(null);
  const host = React.useRef<HTMLElement | null>(null);
  const keep = scroll.ref;
  const boxRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      box.current = element;
      keep(element);
    },
    [keep],
  );

  // Read through a ref so the options stay stable across renders.
  const latest = React.useRef({ reveal, markedLine, onRevealed });
  latest.current = { reveal, markedLine, onRevealed };

  // Only the box scrolls (`scrollWithin`), never the dock that may still be
  // animating open around it.
  const settle = React.useCallback(() => {
    const scroller = box.current;
    const node = host.current;
    const current = latest.current;
    if (scroller === null || node === null || !current.reveal) return;
    const row = current.markedLine === undefined ? null : lineRow(node, current.markedLine);
    if (row === null) {
      scroller.scrollTop = 0;
    } else {
      scrollWithin(scroller, row, "center");
    }
    current.onRevealed();
  }, []);

  const options = React.useMemo(
    () => ({
      ...previewFileOptions(themeType),
      onPostRender: (node: HTMLElement, _instance: unknown, phase: string) => {
        if (phase === "unmount") return;
        const first = host.current === null;
        host.current = node;
        if (latest.current.reveal) {
          settle();
        } else if (first) {
          keep(box.current);
        }
      },
    }),
    [themeType, keep, settle],
  );

  // A reveal asked for after the file has drawn (another line of the same
  // file) needs no new render to find its row.
  React.useEffect(() => {
    if (reveal) settle();
  }, [reveal, markedLine, settle]);

  const file = React.useMemo(
    () => ({
      name: path,
      contents: content.text,
      lang: language,
      cacheKey: previewCacheKey(path, content.text),
    }),
    [path, content.text, language],
  );
  const selectedLines = React.useMemo(
    () => (markedLine === undefined ? null : { start: markedLine, end: markedLine }),
    [markedLine],
  );

  return (
    <div ref={boxRef} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-auto">
      <File
        file={file}
        options={options}
        selectedLines={selectedLines}
        className="block w-max min-w-full text-xs"
      />
    </div>
  );
}
