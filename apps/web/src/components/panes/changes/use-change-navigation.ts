/**
 * The change keys of the Changes list: `changes.nextChange` and
 * `changes.previousChange` move to the next or previous stop in scroll order
 * (`changeStops`, `nextChangeTarget` picks which). An open file stops at each
 * block of changed lines, scrolled to just under its sticky row; a closed file
 * with a patch is one stop of its own, which opens it and scrolls its header
 * to the top the way the file keys do — the press after that lands on its
 * first change. Going back into a closed file opens it the same way and lands
 * on its last change as soon as the patch has rendered. Nothing wraps round.
 *
 * `jumpTo` scrolls to a position and parks the keys there, so a scrollbar
 * mark clicked is where the next press starts from.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import * as React from "react";

import { useKeybindingCommand } from "@/lib/shortcuts";

import { changeStops, nextChangeTarget } from "./change-blocks";
import { type SectionLayout, readSections } from "./diff-dom";
import { EDGE } from "./review";

/** How long a file opened by the previous key may take to render and still be landed in, in ms. */
const PENDING_MS = 3000;

export function useChangeNavigation({
  scrollerRef,
  contentRef,
  files,
  isOpen,
  sections,
  revealFile,
  moveCursor,
}: {
  scrollerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  files: ReadonlyArray<GitDiffFile>;
  isOpen: (path: string) => boolean;
  /** The list as last laid out, to land in a file the previous key opened. */
  sections: ReadonlyArray<SectionLayout>;
  revealFile: (path: string) => void;
  moveCursor: (path: string) => void;
}) {
  // Where the keys last moved to, and the scroll position that left; the keys
  // stand there while the list has not moved since.
  const parked = React.useRef<{ position: number; scrollTop: number } | null>(null);
  // A file the previous key opened, to land on its last change once rendered.
  const pending = React.useRef<{ path: string; since: number } | null>(null);

  const jumpTo = (position: number) => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    scroller.scrollTop = position;
    parked.current = { position, scrollTop: scroller.scrollTop };
  };

  const step = (direction: 1 | -1) => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) {
      return;
    }
    pending.current = null;
    const stops = changeStops(
      readSections(content),
      files.map((file) => file.diff !== "" && !isOpen(file.path)),
    );
    const park = parked.current;
    const isParked = park !== null && Math.abs(scroller.scrollTop - park.scrollTop) <= 1;
    const position = park !== null && isParked ? park.position : scroller.scrollTop;
    const target = nextChangeTarget(
      stops.map((stop) => stop.top),
      position,
      direction,
      isParked,
    );
    const stop = target === null ? undefined : stops[target];
    const file = stop === undefined ? undefined : files[stop.index];
    if (stop === undefined || file === undefined) {
      return;
    }
    if (!stop.opens) {
      moveCursor(file.path);
      jumpTo(stop.top);
      return;
    }
    revealFile(file.path);
    // Stand just above the file's first change, which starts where its
    // header does, so the next press lands on it even when the list could not
    // scroll the header all the way up.
    parked.current = { position: stop.top - 2 * EDGE, scrollTop: scroller.scrollTop };
    if (direction === -1) {
      pending.current = { path: file.path, since: performance.now() };
    }
  };
  useKeybindingCommand("changes.nextChange", () => step(1));
  useKeybindingCommand("changes.previousChange", () => step(-1));

  React.useEffect(() => {
    const want = pending.current;
    if (want === null) {
      return;
    }
    if (performance.now() - want.since > PENDING_MS) {
      pending.current = null;
      return;
    }
    const section = sections[files.findIndex((file) => file.path === want.path)];
    const last = section?.blocks.at(-1);
    if (section !== undefined && last !== undefined) {
      pending.current = null;
      jumpTo(last.top - section.header);
    }
  });

  return { step, jumpTo };
}
