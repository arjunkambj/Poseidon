import type { ItemId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import type { TimelineRow } from "./fold";
import { positionToSave, restoreTarget } from "./reading-position";

const row = (id: string): TimelineRow => ({
  kind: "item",
  id,
  item: { itemId: id as ItemId, kind: "assistant_message", status: "completed" },
});

const anchors = [
  { rowId: "row-b", offset: -18 },
  { rowId: "row-c", offset: 140 },
];

describe("positionToSave", () => {
  it("keeps nothing at the end, so the thread reopens following", () => {
    expect(positionToSave({ atEnd: true, mode: "follow", anchors })).toBeNull();
    expect(positionToSave({ atEnd: true, mode: "free", anchors })).toBeNull();
  });

  it("keeps nothing while a sent message is anchored", () => {
    expect(positionToSave({ atEnd: false, mode: "anchored", anchors })).toBeNull();
  });

  it("keeps the first row on screen and its offset away from the end", () => {
    expect(positionToSave({ atEnd: false, mode: "free", anchors })).toEqual({
      rowKey: "row-b",
      offset: -18,
    });
    expect(positionToSave({ atEnd: false, mode: "follow", anchors })).toEqual({
      rowKey: "row-b",
      offset: -18,
    });
  });

  it("keeps nothing when no row is on screen", () => {
    expect(positionToSave({ atEnd: false, mode: "free", anchors: [] })).toBeNull();
  });
});

describe("restoreTarget", () => {
  const rows = [row("row-a"), row("row-b"), row("row-c")];

  it("finds the saved row's index and keeps its offset", () => {
    expect(restoreTarget(rows, { rowKey: "row-c", offset: 32 })).toEqual({ index: 2, offset: 32 });
  });

  it("opens at the end when the saved row is gone", () => {
    expect(restoreTarget(rows, { rowKey: "work-group:gone", offset: 0 })).toBeUndefined();
  });

  it("opens at the end when nothing was saved", () => {
    expect(restoreTarget(rows, undefined)).toBeUndefined();
  });
});
