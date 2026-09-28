import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { instancesWith, totalCount } from "./customize-instances";

const instance = (
  id: string,
  enabled: boolean,
  extensions: ConnectorSummary["extensions"],
): ConnectorSummary => ({
  connectorInstanceId: id as ConnectorInstanceId,
  kind: "harness",
  displayName: id,
  enabled,
  capabilities: null,
  extensions,
  probe: { status: "ready", probedAt: "2026-09-18T00:00:00.000Z" },
});

describe("instancesWith", () => {
  const connectors = [
    instance("both", true, { skills: true, plugins: false, mcpServers: true }),
    instance("off", false, { skills: true, plugins: false, mcpServers: true }),
    instance("skills-only", true, { skills: true, plugins: false, mcpServers: false }),
    instance("none", true, { skills: false, plugins: false, mcpServers: false }),
  ];

  it("keeps enabled instances that manage the kind, in list order", () => {
    expect(instancesWith(connectors, "skills").map((entry) => entry.displayName)).toEqual([
      "both",
      "skills-only",
    ]);
    expect(instancesWith(connectors, "mcpServers").map((entry) => entry.displayName)).toEqual([
      "both",
    ]);
  });

  it("finds the instances with their own plugins", () => {
    const withPlugins = instance("with-plugins", true, {
      skills: true,
      plugins: true,
      mcpServers: true,
    });
    expect(
      instancesWith([...connectors, withPlugins], "plugins").map((entry) => entry.displayName),
    ).toEqual(["with-plugins"]);
  });

  it("is empty when nothing manages the kind", () => {
    expect(instancesWith([connectors[3]!], "skills")).toEqual([]);
  });
});

describe("totalCount", () => {
  it("adds every instance's list", () => {
    expect(totalCount([2, 0, 3])).toBe(5);
    expect(totalCount([])).toBe(0);
  });

  it("stays unknown until every instance has answered", () => {
    expect(totalCount([2, null])).toBeNull();
  });
});
