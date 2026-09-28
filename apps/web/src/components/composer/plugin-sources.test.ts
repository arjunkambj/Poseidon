import type { PluginSummary } from "@poseidon/contracts/connectors";
import type { PluginsState, PoseidonPlugin } from "@poseidon/contracts/plugins";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";

import { menuSource, type MenuSource } from "@/components/composer/menu-source";
import {
  mergePluginSources,
  POSEIDON_PLUGIN_SOURCE,
  poseidonPluginSummaries,
} from "@/components/composer/plugin-sources";
import { referenceMenuEmptyLabel, referenceMenuItems } from "@/components/composer/reference-menu";

const plugin = (
  overrides: Partial<PoseidonPlugin> & { readonly name: string },
): PoseidonPlugin => ({
  pluginId: `global:${overrides.name}`,
  source: "global",
  path: `/home/.poseidon/plugins/${overrides.name}`,
  enabled: true,
  contents: { skills: [], mcpServers: [], commands: 0, agents: 0, hooks: false },
  ...overrides,
});

const STATE: PluginsState = {
  globalDir: "/home/.poseidon/plugins",
  plugins: [
    plugin({
      name: "browser",
      pluginId: "builtin:browser",
      source: "builtin",
      description: "Drive Poseidon's in-app browser",
    }),
    plugin({ name: "off", enabled: false }),
    plugin({ name: "broken", enabled: false, error: "invalid plugin.json: name is missing" }),
  ],
};

const BROWSER: PluginSummary = {
  name: "browser",
  description: "Drive Poseidon's in-app browser",
  source: POSEIDON_PLUGIN_SOURCE,
  enabled: true,
};

const ready = (entries: ReadonlyArray<PluginSummary>): MenuSource<PluginSummary> => ({
  status: "ready",
  entries,
});

const harnessPlugin = (name: string, enabled = true): PluginSummary => ({
  name,
  source: "team-marketplace",
  scope: "user",
  enabled,
});

describe("poseidonPluginSummaries", () => {
  it("keeps the enabled, valid plugins as Poseidon rows", () => {
    expect(poseidonPluginSummaries(STATE)).toEqual([BROWSER]);
  });
});

describe("mergePluginSources", () => {
  it("lists Poseidon's plugins ahead of the instance's", () => {
    const merged = mergePluginSources(ready([BROWSER]), ready([harnessPlugin("commit-commands")]));
    expect(merged).toEqual({
      status: "ready",
      entries: [BROWSER, harnessPlugin("commit-commands")],
    });
    expect(
      referenceMenuItems({ kind: "mention", query: "", plugins: merged.entries, skills: [] }).map(
        (item) => [item.group, item.label],
      ),
    ).toEqual([
      ["Plugins", "browser"],
      ["Plugins", "commit-commands"],
    ]);
  });

  it("keeps the first row of a name listed twice, and only enabled rows", () => {
    const merged = mergePluginSources(
      ready([BROWSER]),
      ready([harnessPlugin("browser"), harnessPlugin("off", false), harnessPlugin("review")]),
    );
    expect(merged.entries).toEqual([BROWSER, harnessPlugin("review")]);
  });

  it("lists the Browser plugin for an instance without the plugins extension", () => {
    const unavailable = AsyncResult.failure<ReadonlyArray<PluginSummary>, PoseidonRpcError>(
      Cause.fail(new PoseidonRpcError({ code: "unavailable", message: "no plugins" })),
    );
    const merged = mergePluginSources(
      menuSource(AsyncResult.map(AsyncResult.success(STATE), poseidonPluginSummaries)),
      menuSource(unavailable),
    );
    expect(merged).toEqual({ status: "ready", entries: [BROWSER] });
  });

  it("is loading while either list is still being asked", () => {
    const merged = mergePluginSources(
      menuSource(AsyncResult.initial<ReadonlyArray<PluginSummary>>()),
      ready([harnessPlugin("review")]),
    );
    expect(merged).toEqual({ status: "loading", entries: [harnessPlugin("review")] });
  });

  it("reads a failed Poseidon list like a failed instance list", () => {
    const failed = AsyncResult.failure<ReadonlyArray<PluginSummary>, PoseidonRpcError>(
      Cause.fail(new PoseidonRpcError({ code: "internal", message: "registry down" })),
    );
    const merged = mergePluginSources(menuSource(failed), ready([]));
    expect(merged).toEqual({ status: "failed", entries: [] });
    expect(
      referenceMenuEmptyLabel({
        kind: "mention",
        query: "",
        plugins: merged,
        skills: { status: "ready", entries: [] },
      }),
    ).toBe("Could not list plugins");
  });
});
