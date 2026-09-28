/**
 * A comparison's files once its diff has answered, with the thread's review
 * over them (`useChangesReview`, the rules in `./review`).
 *
 * One line above the files sums the comparison up — how many files, how many
 * lines, how many the user has viewed — with the toggle that opens or closes
 * them all at once. It stays put and the files scroll under it.
 *
 * The list answers `changes.nextFile` and `changes.previousFile` while it is
 * on screen: each opens the file it lands on and scrolls that file's header to
 * the top (`stepFile` picks which). A file a link asks for (`reveal`) is
 * opened and scrolled to the same way, once, as soon as the files are in —
 * found by `linkedFileIndex`, since the timeline's path is often absolute.
 * Picking a file in the tree beside the files (`FileTree`, shown or hidden
 * from the summary line and remembered for the app session) does the same;
 * each of these goes through `revealFile`.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import * as React from "react";

import { scrollWithin } from "@/lib/scroll-within";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useChangesTreeOpen } from "@/state/changes-view";
import { useChangesReview, type DiffStyle } from "@/state/ui";

import { linkedFileIndex } from "./deep-link";
import { FileSection } from "./file-section";
import { FileTree } from "./file-tree-view";
import {
  everyFileOpen,
  isOpen,
  isViewed,
  patchHash,
  stepFile,
  withOpen,
  withViewed,
} from "./review";
import { ReviewSummary, TreeToggle } from "./review-summary";

export function ReviewList({
  threadId,
  files,
  prefix,
  diffStyle,
  reveal,
  onRevealed,
}: {
  threadId: string;
  files: ReadonlyArray<GitDiffFile>;
  /** `GitDiff.prefix`, for the file menus. */
  prefix: string;
  diffStyle: DiffStyle;
  reveal: string | null;
  onRevealed: () => void;
}) {
  const [review, updateReview] = useChangesReview(threadId);
  // Hashed once per answer from git, not per render: a patch can be megabytes.
  const hashed = React.useMemo(
    () => files.map((file) => ({ file, path: file.path, hash: patchHash(file.diff) })),
    [files],
  );
  const setOpen = (paths: ReadonlyArray<string>, open: boolean) =>
    updateReview((current) => withOpen(current, paths, open));

  // The file the keys last moved to, or the one last clicked or picked in the
  // tree. By path, so a refresh that reorders or drops files cannot point it
  // at another one. A ref for the keys, state for the tree's highlight.
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const cursor = React.useRef<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const moveCursor = (path: string) => {
    cursor.current = path;
    setSelected(path);
  };

  // Opens the file when it has a patch and scrolls its header to the top;
  // only the list moves, never the dock around it (`scrollWithin`). One
  // `<section>` per file, in file order.
  const revealFile = (path: string) => {
    const index = files.findIndex((file) => file.path === path);
    const file = files[index];
    if (file === undefined) {
      return;
    }
    moveCursor(file.path);
    if (file.diff !== "") {
      setOpen([file.path], true);
    }
    const scroller = scrollerRef.current;
    if (scroller !== null) {
      scrollWithin(scroller, scroller.children[index]);
    }
  };
  const revealRef = React.useRef(revealFile);
  revealRef.current = revealFile;

  const step = (direction: 1 | -1) => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const top = scroller.getBoundingClientRect().top;
    const target = stepFile(
      [...scroller.children].map((section) => section.getBoundingClientRect().top - top),
      scroller.clientHeight,
      files.findIndex((file) => file.path === cursor.current),
      direction,
    );
    const file = target === null ? undefined : files[target];
    if (file !== undefined) {
      revealFile(file.path);
    }
  };
  useKeybindingCommand("changes.nextFile", () => step(1));
  useKeybindingCommand("changes.previousFile", () => step(-1));

  // A file this comparison does not have is dropped all the same: the link has
  // been answered, and a later comparison that has it must not jump to it.
  React.useEffect(() => {
    if (reveal === null) {
      return;
    }
    onRevealed();
    const index = linkedFileIndex(
      files.map((file) => file.path),
      reveal,
    );
    const file = files[index];
    if (file !== undefined) {
      revealRef.current(file.path);
    }
  }, [reveal, onRevealed, files]);

  const [treeOpen, setTreeOpen] = useChangesTreeOpen();
  const viewedPaths = React.useMemo(
    () =>
      new Set(
        hashed.filter(({ path, hash }) => isViewed(review, path, hash)).map(({ path }) => path),
      ),
    [hashed, review],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReviewSummary
        files={files}
        viewed={viewedPaths.size}
        allOpen={everyFileOpen(review, files)}
        onAllOpenChange={(open) =>
          setOpen(
            files.filter((file) => file.diff !== "").map((file) => file.path),
            open,
          )
        }
        tree={<TreeToggle open={treeOpen} onOpenChange={setTreeOpen} />}
      />
      <div className="flex min-h-0 flex-1 border-t border-border">
        {treeOpen ? (
          <FileTree
            threadId={threadId}
            files={files}
            viewed={viewedPaths}
            selected={selected}
            onSelect={revealFile}
            className="w-56 shrink-0 border-r border-border"
          />
        ) : null}
        <div ref={scrollerRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {hashed.map(({ file, hash }) => (
            <FileSection
              key={file.path}
              threadId={threadId}
              file={file}
              prefix={prefix}
              open={isOpen(review, file.path)}
              onOpenChange={(open) => {
                moveCursor(file.path);
                setOpen([file.path], open);
              }}
              viewed={viewedPaths.has(file.path)}
              onViewedChange={(viewed) =>
                updateReview((current) => withViewed(current, file.path, viewed ? hash : null))
              }
              diffStyle={diffStyle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
