import { describe, expect, it } from "vitest";

import { slashMenuItems } from "@/components/composer/slash-menu";

const rootItems = (query: string, canCompact: boolean) =>
  slashMenuItems({
    level: "root",
    query,
    skills: [],
    models: [],
    efforts: undefined,
    capabilities: null,
    canCompact,
  });

const labels = (query: string, canCompact: boolean) =>
  rootItems(query, canCompact).map((item) => item.label);

describe("slashMenuItems /compact", () => {
  it("is listed before /clear-draft when the bound session can compact", () => {
    const listed = labels("", true);
    expect(listed).toContain("/compact");
    expect(listed.indexOf("/compact")).toBe(listed.indexOf("/clear-draft") - 1);
  });

  it("is absent when the session cannot compact", () => {
    expect(labels("", false)).not.toContain("/compact");
    expect(labels("comp", false)).toEqual([]);
  });

  it("is what the query comp finds", () => {
    expect(labels("comp", true)).toEqual(["/compact"]);
  });

  it("asks the composer to compact", () => {
    const item = rootItems("compact", true).find((entry) => entry.id === "builtin:compact");
    expect(item?.action).toEqual({ type: "compact" });
  });
});
