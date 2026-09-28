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
 * each of these goes through `revealFile`. In a list narrower than
 * `TREE_ASIDE_MIN_WIDTH` the tree folds into a dropdown in the summary line
 * (`FileJumpMenu`) instead (`treeLayout`).
 *
 * "Next unviewed" (`changes.nextUnviewed`, and its button in the summary line)
 * reveals the first file after the cursor that is not viewed as it is now,
 * wrapping round (`nextUnviewed`). The change keys and their buttons move
 * between blocks of changed lines (`useChangeNavigation`), over the list as
 * last laid out (`useReviewLayout`).
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import * as React from "react";

import { scrollWithin } from "@/lib/scroll-within";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useChangesTreeOpen } from "@/state/changes-view";
import { useChangesReview, type DiffStyle } from "@/state/ui";

import { linkedFileIndex } from "./deep-link";
import { FileJumpMenu } from "./file-jump-menu";
import { FileSection } from "./file-section";
import { treeLayout } from "./file-tree";
import { FileTree } from "./file-tree-view";
import {
  everyFileOpen,
  isOpen,
  isViewed,
  nextUnviewed,
  patchHash,
  stepFile,
  withOpen,
  withViewed,
} from "./review";
import { ReviewNav } from "./review-nav";
import { ReviewSummary, TreeToggle } from "./review-summary";
import { useChangeNavigation } from "./use-change-navigation";
import { useElementWidth } from "./use-element-width";
import { useReviewLayout } from "./use-review-layout";

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
  const contentRef = React.useRef<HTMLDivElement>(null);
  const cursor = React.useRef<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const moveCursor = (path: string) => {
    cursor.current = path;
    setSelected(path);
  };

  // Opens the file when it has a patch and scrolls its header to the top;
  // only the list moves, never the dock around it (`scrollWithin`). One
  // `<section>` per file, in file order, in the scroller's content.
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
      scrollWithin(scroller, contentRef.current?.children[index]);
    }
  };
  const revealRef = React.useRef(revealFile);
  revealRef.current = revealFile;

  const step = (direction: 1 | -1) => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) {
      return;
    }
    const top = scroller.getBoundingClientRect().top;
    const target = stepFile(
      [...content.children].map((section) => section.getBoundingClientRect().top - top),
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

  const revealUnviewed = () => {
    const target = nextUnviewed(
      hashed,
      review,
      files.findIndex((file) => file.path === cursor.current),
    );
    const file = target === null ? undefined : files[target];
    if (file !== undefined) {
      revealFile(file.path);
    }
  };
  useKeybindingCommand("changes.nextUnviewed", revealUnviewed);

  const reviewLayout = useReviewLayout(scrollerRef, contentRef, review.open);
  const changes = useChangeNavigation({
    scrollerRef,
    contentRef,
    files,
    isOpen: (path) => isOpen(review, path),
    sections: reviewLayout.sections,
    revealFile,
    moveCursor,
  });

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

  // Beside the diffs when the list is wide enough, else behind a dropdown.
  const listRef = React.useRef<HTMLDivElement>(null);
  const [treeOpen, setTreeOpen] = useChangesTreeOpen();
  const layout = treeLayout(useElementWidth(listRef), treeOpen);
  const viewedPaths = React.useMemo(
    () =>
      new Set(
        hashed.filter(({ path, hash }) => isViewed(review, path, hash)).map(({ path }) => path),
      ),
    [hashed, review],
  );

  const treeProps = { threadId, files, viewed: viewedPaths, selected, onSelect: revealFile };

  return (
    <div ref={listRef} className="flex min-h-0 flex-1 flex-col">
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
        nav={
          <ReviewNav
            canStepChange={files.some((file) => file.diff !== "")}
            onStepChange={changes.step}
            allViewed={viewedPaths.size === files.length}
            onNextUnviewed={revealUnviewed}
          />
        }
        tree={
          layout === "dropdown" ? (
            <FileJumpMenu {...treeProps} />
          ) : (
            <TreeToggle open={treeOpen} onOpenChange={setTreeOpen} />
          )
        }
      />
      <div className="flex min-h-0 flex-1 border-t border-border">
        {layout === "aside" ? (
          <FileTree {...treeProps} className="w-56 shrink-0 border-r border-border" />
        ) : null}
        <div ref={scrollerRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div ref={contentRef}>
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
    </div>
  );
}
