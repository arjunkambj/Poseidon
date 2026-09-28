import { describe, expect, it } from "vitest";

import { reviewMenuEntries } from "./review-menu-items";

const file = { path: "src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" };
const noop = () => {};

describe("reviewMenuEntries", () => {
  it("offers only Copy diff outside a review scope", () => {
    expect(reviewMenuEntries(file, undefined).map((entry) => entry.kind)).toEqual(["copy-diff"]);
  });

  it("adds Show blame and Discard in a review scope", () => {
    const entries = reviewMenuEntries(file, {
      onShowBlame: noop,
      onDiscard: noop,
      discardDisabledReason: null,
    });
    expect(entries.map((entry) => entry.kind)).toEqual(["copy-diff", "blame", "discard"]);
  });

  it("leaves blame out for a deleted file, and keeps Discard's reason", () => {
    const entries = reviewMenuEntries(
      { ...file, diff: "" },
      { onShowBlame: undefined, onDiscard: noop, discardDisabledReason: "Offline." },
    );
    expect(entries).toEqual([{ kind: "discard", onSelect: noop, disabledReason: "Offline." }]);
  });
});
