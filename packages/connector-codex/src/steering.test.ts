/**
 * When a steer is refused before the CLI is asked, and which turn is the
 * request to compact.
 */

import { describe, expect, it } from "vitest";

import { COMPACT_COMMAND, isCompactCommand } from "./compaction";
import { steerRefusal } from "./steering";

describe("steerRefusal", () => {
  it("refuses with no turn running, a turn stopping, or a compaction", () => {
    expect(steerRefusal(null)).toBe("no turn is running");
    expect(steerRefusal({ interrupted: true, compaction: false })).toBe(
      "the running turn is stopping",
    );
    expect(steerRefusal({ interrupted: false, compaction: true })).toMatch(/compaction/);
  });

  it("lets a running turn be steered", () => {
    expect(steerRefusal({ interrupted: false, compaction: false })).toBeUndefined();
  });
});

describe("isCompactCommand", () => {
  const turn = (text: string) => ({ text, attachments: [], mentions: [] });

  it("is the /compact turn alone, spaces aside", () => {
    expect(isCompactCommand(turn(COMPACT_COMMAND))).toBe(true);
    expect(isCompactCommand(turn(`  ${COMPACT_COMMAND}\n`))).toBe(true);
    expect(isCompactCommand(turn("/compact now please"))).toBe(false);
    expect(isCompactCommand(turn("compact"))).toBe(false);
  });
});
