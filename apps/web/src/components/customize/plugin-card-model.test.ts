import { describe, expect, it } from "vitest";

import type { PoseidonPlugin } from "@poseidon/contracts/plugins";

import {
  contentsLine,
  harnessPluginCard,
  poseidonPluginCard,
  sourceLabel,
  splitBySource,
} from "./plugin-card-model";

const emptyContents = { skills: [], mcpServers: [], commands: 0, agents: 0, hooks: false };

const plugin = (overrides: Partial<PoseidonPlugin> = {}): PoseidonPlugin => ({
  pluginId: "builtin:browser",
  name: "browser",
  description: "Drive the in-app browser",
  source: "builtin",
  path: "/home/.poseidon/builtin-plugins/browser",
  enabled: true,
  contents: { ...emptyContents, skills: [{ name: "browser" }] },
  ...overrides,
});

describe("contentsLine", () => {
  it("leaves out the parts that are zero", () => {
    expect(contentsLine(emptyContents)).toBe("");
    expect(contentsLine({ ...emptyContents, skills: [{ name: "a" }] })).toBe("1 skill");
  });

  it("counts every part in a fixed order, singular and plural", () => {
    expect(
      contentsLine({
        skills: [{ name: "a" }, { name: "b" }],
        mcpServers: ["github"],
        commands: 3,
        agents: 1,
        hooks: true,
      }),
    ).toBe("2 skills · 1 MCP server · 3 commands · 1 agent · hooks");
    expect(contentsLine({ ...emptyContents, mcpServers: ["a", "b"], commands: 1 })).toBe(
      "2 MCP servers · 1 command",
    );
  });
});

describe("poseidonPluginCard", () => {
  it("labels the source and keeps the switch live", () => {
    expect(sourceLabel("builtin")).toBe("Built-in");
    expect(sourceLabel("global")).toBe("Global");
    const card = poseidonPluginCard(plugin());
    expect(card).toMatchObject({
      key: "builtin:browser",
      sourceLabel: "Built-in",
      contents: "1 skill",
      enabled: true,
      error: undefined,
      pluginId: "builtin:browser",
    });
  });

  it("carries the warnings of a plugin that loaded with problems", () => {
    expect(poseidonPluginCard(plugin()).warnings).toEqual([]);
    const warnings = ['skill "notes" has no description', 'MCP server "db" was skipped'];
    expect(poseidonPluginCard(plugin({ warnings })).warnings).toEqual(warnings);
    // An invalid plugin shows its error, not what it would have warned about.
    expect(poseidonPluginCard(plugin({ warnings, error: "broken" })).warnings).toEqual([]);
  });

  it("shows a disabled plugin as off", () => {
    expect(poseidonPluginCard(plugin({ enabled: false })).enabled).toBe(false);
  });

  it("marks an invalid plugin off, with its error and no contents", () => {
    const card = poseidonPluginCard(
      plugin({
        pluginId: "global:broken",
        name: "broken",
        source: "global",
        enabled: true,
        error: "invalid plugin.json: name is missing",
      }),
    );
    expect(card).toMatchObject({
      sourceLabel: "Global",
      enabled: false,
      contents: "",
      error: "invalid plugin.json: name is missing",
    });
  });
});

describe("harnessPluginCard", () => {
  it("is read-only and names its marketplace and scope", () => {
    const card = harnessPluginCard(
      { name: "commit-commands", source: "fixtures", scope: "project", enabled: false },
      "Acme CLI",
      "acme-1",
    );
    expect(card).toMatchObject({
      sourceLabel: "Acme CLI",
      contents: "fixtures · project scope",
      enabled: false,
      warnings: [],
      pluginId: null,
    });
    expect(card.key).toBe("acme-1:fixtures:project:commit-commands");
  });

  it("leaves the line empty with no source or scope", () => {
    expect(harnessPluginCard({ name: "x", enabled: true }, "Acme CLI", "c").contents).toBe("");
  });
});

describe("splitBySource", () => {
  it("keeps built-in and global plugins apart in list order", () => {
    const a = plugin({ pluginId: "global:a", name: "a", source: "global" });
    const b = plugin({ pluginId: "global:b", name: "b", source: "global" });
    const browser = plugin();
    expect(splitBySource([browser, a, b])).toEqual({ builtin: [browser], global: [a, b] });
  });
});
