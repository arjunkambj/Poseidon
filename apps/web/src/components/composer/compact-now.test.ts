import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
  COMPACT_COMMAND,
  COMPACT_WHILE_RUNNING,
  canCompact,
  compactRefusal,
} from "@/components/composer/compact-now";

const capabilities = (compaction: boolean) => ({ compaction }) as ConnectorCapabilities;

describe("canCompact", () => {
  it("is true only when the bound session declared compaction", () => {
    expect(canCompact(capabilities(true))).toBe(true);
    expect(canCompact(capabilities(false))).toBe(false);
    expect(canCompact(null)).toBe(false);
    expect(canCompact(undefined)).toBe(false);
  });
});

describe("compactRefusal", () => {
  it("lets an idle thread compact", () => {
    expect(compactRefusal({ running: false, pending: false })).toBeNull();
  });

  it("refuses while a turn runs, with the reason", () => {
    expect(compactRefusal({ running: true, pending: false })).toBe(COMPACT_WHILE_RUNNING);
    expect(compactRefusal({ running: true, pending: true })).toBe(COMPACT_WHILE_RUNNING);
  });

  it("holds a second press while the first is in flight", () => {
    expect(compactRefusal({ running: false, pending: true })).not.toBeNull();
  });
});

describe("COMPACT_COMMAND", () => {
  it("is the text a typed /compact sends", () => {
    expect(COMPACT_COMMAND).toBe("/compact");
  });
});
