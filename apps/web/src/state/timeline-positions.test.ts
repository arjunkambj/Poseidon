import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { describe, expect, it } from "vitest";

import {
  MAX_TIMELINE_POSITIONS,
  timelinePositionsAtom,
  withTimelinePosition,
} from "./timeline-positions";

const at = (rowKey: string, offset = 0) => ({ rowKey, offset });

describe("withTimelinePosition", () => {
  it("saves a thread's position", () => {
    expect(withTimelinePosition({}, "t1", at("row-a", 12))).toEqual({ t1: at("row-a", 12) });
  });

  it("replaces a thread's earlier position", () => {
    const first = withTimelinePosition({}, "t1", at("row-a", 12));
    expect(withTimelinePosition(first, "t1", at("row-b", -4))).toEqual({ t1: at("row-b", -4) });
  });

  it("deletes a thread's position on null", () => {
    const saved = withTimelinePosition(withTimelinePosition({}, "t1", at("a")), "t2", at("b"));
    expect(withTimelinePosition(saved, "t1", null)).toEqual({ t2: at("b") });
  });

  it("returns the same map when deleting a thread it does not hold", () => {
    const saved = withTimelinePosition({}, "t1", at("a"));
    expect(withTimelinePosition(saved, "t2", null)).toBe(saved);
  });

  it("drops the oldest thread past the cap", () => {
    let positions = {};
    for (let index = 0; index <= MAX_TIMELINE_POSITIONS; index += 1) {
      positions = withTimelinePosition(positions, `t${index}`, at(`row-${index}`));
    }
    const keys = Object.keys(positions);
    expect(keys).toHaveLength(MAX_TIMELINE_POSITIONS);
    expect(keys).not.toContain("t0");
    expect(keys.at(-1)).toBe(`t${MAX_TIMELINE_POSITIONS}`);
  });

  it("moves a thread saved again to the newest place", () => {
    let positions = {};
    for (let index = 0; index < MAX_TIMELINE_POSITIONS; index += 1) {
      positions = withTimelinePosition(positions, `t${index}`, at(`row-${index}`));
    }
    positions = withTimelinePosition(positions, "t0", at("row-again"));
    expect(Object.keys(positions).at(-1)).toBe("t0");
    positions = withTimelinePosition(positions, "t-new", at("row-new"));
    const keys = Object.keys(positions);
    expect(keys).toHaveLength(MAX_TIMELINE_POSITIONS);
    expect(keys).toContain("t0");
    expect(keys).not.toContain("t1");
  });
});

describe("timelinePositionsAtom", () => {
  it("keeps positions after the timeline, its last subscriber, unmounts", () => {
    // The registry drops an unobserved node in a scheduled task; run those by hand.
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {
          const index = tasks.indexOf(task);
          if (index !== -1) {
            tasks.splice(index, 1);
          }
        };
      },
    });
    const release = registry.subscribe(timelinePositionsAtom, () => {});
    registry.set(timelinePositionsAtom, withTimelinePosition({}, "t1", at("row-a", 8)));
    release();
    for (const task of tasks.splice(0)) {
      task();
    }
    expect(registry.get(timelinePositionsAtom)).toEqual({ t1: at("row-a", 8) });
  });
});
