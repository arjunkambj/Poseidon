import { describe, expect, it } from "vitest";

import { reviewMenuEntries } from "./review-menu-items";

const file = { path: "src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" };
const noop = () => {};

describe("reviewMenuEntries", () => {
  it("offers only Copy diff outside a review scope", () => {
    expect(reviewMenuEntries(file, undefined).map((entry) => entry.kind)).toEqual(["copy-diff"]);
  });

  it("adds Discard in a review scope", () => {
    const entries = reviewMenuEntries(file, { onDiscard: noop, discardDisabledReason: null });
    expect(entries.map((entry) => entry.kind)).toEqual(["copy-diff", "discard"]);
  });

  it("keeps Discard's reason, and offers it for a file with no patch", () => {
    const entries = reviewMenuEntries(
      { ...file, diff: "" },
      { onDiscard: noop, discardDisabledReason: "Offline." },
    );
    expect(entries).toEqual([{ kind: "discard", onSelect: noop, disabledReason: "Offline." }]);
  });
});
