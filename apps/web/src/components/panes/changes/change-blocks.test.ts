/**
 * The Changes list's change blocks: rows grouped by touching, where the change
 * keys stop, and which stop they move to.
 */

import { describe, expect, it } from "vitest";

import { type ChangeRow, changeBlocks, changeStops, nextChangeTarget } from "./change-blocks";

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
