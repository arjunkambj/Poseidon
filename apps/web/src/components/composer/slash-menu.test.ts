import { describe, expect, it } from "vitest";

import type { SkillSummary } from "@poseidon/contracts/connectors";
import type { HarnessCommand } from "@poseidon/contracts/harnessCommands";

import { slashMenuItems } from "@/components/composer/slash-menu";

const rootItems = (
  query: string,
  canCompact: boolean,
  harnessCommands: ReadonlyArray<HarnessCommand> = [],
  skills: ReadonlyArray<SkillSummary> = [],
) =>
  slashMenuItems({
    level: "root",
    query,
    skills,
    harnessCommands,
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

describe("slashMenuItems harness commands", () => {
  const review: HarnessCommand = {
    name: "review",
    description: "Review a pull request",
    argumentHint: "[focus]",
  };
  const cost: HarnessCommand = { name: "cost", description: "Show the session's cost" };

  it("lists them last under a Harness heading and inserts the command as text", () => {
    const items = rootItems("", true, [review, cost]);
    const harness = items.filter((item) => item.group === "Harness");
    expect(harness.map((item) => item.label)).toEqual(["/review", "/cost"]);
    expect(items.slice(-2)).toEqual(harness);
    expect(harness[0]).toMatchObject({
      id: "harness:review",
      description: "Review a pull request · [focus]",
      action: { type: "insert", text: "/review " },
    });
    expect(harness[1]?.description).toBe("Show the session's cost");
  });

  it("describes a command by its argument hint alone when it has no description", () => {
    const [item] = rootItems("", true, [{ name: "add-dir", argumentHint: "<path>" }]).filter(
      (entry) => entry.group === "Harness",
    );
    expect(item?.description).toBe("<path>");
    expect(rootItems("", true, [{ name: "bare" }]).at(-1)?.description).toBeUndefined();
  });

  it("leaves out names Poseidon offers itself, the harness's /clear and enabled skills", () => {
    const native = ["model", "effort", "mode", "plan", "default", "compact", "clear-draft"];
    const skill: SkillSummary = { name: "deploy", path: "/skills/deploy", enabled: true };
    const disabled: SkillSummary = { name: "lint", path: "/skills/lint", enabled: false };
    const commands = [...native, "clear", "deploy", "lint", "cost"].map((name) => ({ name }));
    for (const canCompact of [true, false]) {
      const harness = rootItems("", canCompact, commands, [skill, disabled])
        .filter((item) => item.group === "Harness")
        .map((item) => item.label);
      expect(harness).toEqual(["/lint", "/cost"]);
    }
  });

  it("filters them by the query on name, description and hint", () => {
    const harness = (query: string) =>
      rootItems(query, true, [review, cost])
        .filter((item) => item.group === "Harness")
        .map((item) => item.label);
    expect(harness("rev")).toEqual(["/review"]);
    expect(harness("session's")).toEqual(["/cost"]);
    expect(harness("focus")).toEqual(["/review"]);
    expect(harness("nothing-like-it")).toEqual([]);
  });
});
