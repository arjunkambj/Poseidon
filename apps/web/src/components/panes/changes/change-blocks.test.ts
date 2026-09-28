/**
 * The Changes list's change blocks: rows grouped by touching, where the change
 * keys stop, which stop they move to, and the scrollbar's marks.
 */

import { describe, expect, it } from "vitest";

import {
  type ChangeRow,
  MARKER_MIN_HEIGHT,
  changeBlocks,
  changeStops,
  fileChangeKind,
  markerItems,
  markerLayout,
  nextChangeTarget,
} from "./change-blocks";

const added = (top: number, height = 20): ChangeRow => ({
  top,
  bottom: top + height,
  type: "change-addition",
});
const removed = (top: number, height = 20): ChangeRow => ({
  top,
  bottom: top + height,
  type: "change-deletion",
});

describe("changeBlocks", () => {
  it("groups touching rows and starts a new block at any gap", () => {
    // Two removed lines, the two that replace them, an unchanged line, one added.
    expect(changeBlocks([removed(0), removed(20), added(40), added(60), added(100)])).toEqual([
      { top: 0, bottom: 80, kind: "mixed" },
      { top: 100, bottom: 120, kind: "added" },
    ]);
  });

  it("keeps a block's kind when every row agrees", () => {
    expect(changeBlocks([removed(0), removed(20)])).toEqual([
      { top: 0, bottom: 40, kind: "removed" },
    ]);
  });

  it("folds split view's two columns, which come column by column, into one block per height", () => {
    // The removed column renders first, then the added one beside it.
    const rows = [removed(40), removed(60), removed(200), added(40), added(60), added(80)];
    expect(changeBlocks(rows)).toEqual([
      { top: 40, bottom: 100, kind: "mixed" },
      { top: 200, bottom: 220, kind: "removed" },
    ]);
  });

  it("tolerates a sub-pixel seam between rows and has nothing for no rows", () => {
    expect(changeBlocks([added(0, 19.6), added(20.4)])).toHaveLength(1);
    expect(changeBlocks([])).toEqual([]);
  });
});

describe("nextChangeTarget", () => {
  const tops = [100, 300, 500];

  it("from a free scroll, lands on the first block at or below the view's top", () => {
    expect(nextChangeTarget(tops, 0, 1, false)).toBe(0);
    // A file just revealed: its first change sits right at the top.
    expect(nextChangeTarget(tops, 300, 1, false)).toBe(1);
    expect(nextChangeTarget(tops, 301, 1, false)).toBe(1);
    expect(nextChangeTarget(tops, 310, 1, false)).toBe(2);
    expect(nextChangeTarget(tops, 600, 1, false)).toBeNull();
  });

  it("parked on a block, moves strictly past it", () => {
    expect(nextChangeTarget(tops, 300, 1, true)).toBe(2);
    expect(nextChangeTarget(tops, 500, 1, true)).toBeNull();
  });

  it("goes back to the last block above the position", () => {
    expect(nextChangeTarget(tops, 300, -1, true)).toBe(0);
    expect(nextChangeTarget(tops, 400, -1, false)).toBe(1);
    expect(nextChangeTarget(tops, 100, -1, false)).toBeNull();
  });

  it("has nowhere to go with no blocks", () => {
    expect(nextChangeTarget([], 0, 1, false)).toBeNull();
    expect(nextChangeTarget([], 0, -1, false)).toBeNull();
  });
});

describe("changeStops", () => {
  const block = (top: number) => ({ top, bottom: top + 20, kind: "added" as const });

  it("stops at each block of an open file, just under its sticky row", () => {
    const sections = [{ top: 0, header: 28, blocks: [block(40), block(120)] }];
    expect(changeStops(sections, [false])).toEqual([
      { index: 0, top: 12, opens: false },
      { index: 0, top: 92, opens: false },
    ]);
  });

  it("stops once at a closed file's header, and never at an open one with nothing rendered", () => {
    const sections = [
      { top: 0, header: 28, blocks: [] },
      { top: 28, header: 28, blocks: [] },
      { top: 56, header: 28, blocks: [block(100)] },
    ];
    // File 0 is closed with a patch, file 1 open and still rendering.
    expect(changeStops(sections, [true, false, false])).toEqual([
      { index: 0, top: 0, opens: true },
      { index: 2, top: 72, opens: false },
    ]);
  });
});

describe("scrollbar marks", () => {
  const sections = [
    {
      top: 0,
      bottom: 300,
      header: 28,
      blocks: [
        { top: 60, bottom: 80, kind: "added" as const },
        { top: 200, bottom: 260, kind: "mixed" as const },
      ],
    },
    { top: 300, bottom: 328, header: 28, blocks: [] },
    { top: 328, bottom: 356, header: 28, blocks: [] },
  ];
  const files = [
    { kind: "edit" as const },
    { kind: "create" as const },
    { kind: "delete" as const },
  ];

  it("marks each block of an open file and the header of every other", () => {
    expect(markerItems(sections, files, [true, false, false])).toEqual([
      { top: 60, height: 20, kind: "added", target: 32 },
      { top: 200, height: 60, kind: "mixed", target: 172 },
      { top: 300, height: 28, kind: "added", target: 300 },
      { top: 328, height: 28, kind: "removed", target: 328 },
    ]);
  });

  it("marks an open file whose patch has not rendered at its header", () => {
    expect(markerItems(sections.slice(1, 2), files.slice(1, 2), [true])).toEqual([
      { top: 300, height: 28, kind: "added", target: 300 },
    ]);
  });

  it("colours a file by what it does", () => {
    expect(fileChangeKind("create")).toBe("added");
    expect(fileChangeKind("delete")).toBe("removed");
    expect(fileChangeKind("edit")).toBe("mixed");
  });

  it("scales marks onto the track, never thinner than the least height nor past its end", () => {
    const [block, tiny, last] = markerLayout(
      [
        { top: 250, height: 100, kind: "added", target: 0 },
        { top: 500, height: 1, kind: "removed", target: 0 },
        { top: 999, height: 1, kind: "mixed", target: 7 },
      ],
      1000,
      300,
    );
    expect(block).toEqual({ top: 25, height: 10, kind: "added", target: 0 });
    const least = (MARKER_MIN_HEIGHT / 300) * 100;
    expect(tiny?.top).toBe(50);
    expect(tiny?.height).toBeCloseTo(least);
    // Kept inside the track, and the click target stays in px.
    expect(last?.top).toBeCloseTo(100 - least);
    expect(last?.target).toBe(7);
  });

  it("marks nothing without a height to scale by", () => {
    const items = [{ top: 0, height: 10, kind: "added" as const, target: 0 }];
    expect(markerLayout(items, 0, 300)).toEqual([]);
    expect(markerLayout(items, 1000, 0)).toEqual([]);
  });
});
