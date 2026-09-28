/**
 * Finding a linked line in a file's rendered diff: the row on the new side
 * inside the diff's shadow root, looked for once a frame until it renders or
 * the tries run out.
 */

import { describe, expect, it, vi } from "vitest";

import {
  findDiffLine,
  newSideRow,
  whenDiffLine,
  type FrameClock,
  type LineSearchRoot,
} from "./reveal-line";

/** A section whose diff host answers `rows` by selector once `rendered` is true. */
const sectionWith = (rows: Record<string, string>, state = { rendered: true }) => {
  const selectors: Array<string> = [];
  const shadowRoot: LineSearchRoot = {
    querySelector: (selector) => {
      selectors.push(selector);
      if (!state.rendered) return null;
      const row = rows[selector];
      return row === undefined ? null : ({ row, shadowRoot: null } as never);
    },
  };
  const section: LineSearchRoot = {
    querySelector: (selector) => (selector === "diffs-container" ? { shadowRoot } : null),
  };
  return { section, selectors, state };
};

const LINE_12 = newSideRow(12);

/** Frames run only when the test steps them. */
const manualClock = () => {
  const queue: Array<() => void> = [];
  const clock: FrameClock = {
    request: (callback) => queue.push(callback),
    cancel: (handle) => {
      queue[handle - 1] = () => {};
    },
  };
  return { clock, step: () => queue.shift()?.(), pending: () => queue.length };
};

describe("findDiffLine", () => {
  it("asks for the line's new-side row, outside a split diff's old column", () => {
    expect(newSideRow(12)).toBe(
      'code:not([data-deletions]) [data-line="12"]:not([data-line-type="change-deletion"])',
    );
  });

  it("finds the new side's row of the line in the diff's shadow root", () => {
    const { section, selectors } = sectionWith({ [LINE_12]: "row 12" });
    expect(findDiffLine<{ row: string }>(section, 12)?.row).toBe("row 12");
    expect(selectors).toEqual([LINE_12]);
  });

  it("is null before the diff has rendered, or without a diff at all", () => {
    expect(findDiffLine(sectionWith({}, { rendered: false }).section, 12)).toBeNull();
    expect(findDiffLine({ querySelector: () => null }, 12)).toBeNull();
  });
});

describe("whenDiffLine", () => {
  it("looks once a frame until the row renders, then stops", () => {
    const { section, state } = sectionWith({ [LINE_12]: "row 12" }, { rendered: false });
    const { clock, step, pending } = manualClock();
    const found = vi.fn();
    whenDiffLine(section, 12, found, clock, 10);
    expect(found).not.toHaveBeenCalled();
    step();
    state.rendered = true;
    step();
    expect(found).toHaveBeenCalledWith(expect.objectContaining({ row: "row 12" }));
    expect(pending()).toBe(0);
  });

  it("gives up after its tries, and a cancel stops it early", () => {
    const { section } = sectionWith({}, { rendered: false });
    const { clock, step, pending } = manualClock();
    const found = vi.fn();
    whenDiffLine(section, 12, found, clock, 3);
    step();
    step();
    expect(pending()).toBe(0);

    const second = manualClock();
    const cancel = whenDiffLine(section, 12, found, second.clock, 3);
    cancel();
    second.step();
    expect(second.pending()).toBe(0);
    expect(found).not.toHaveBeenCalled();
  });
});
