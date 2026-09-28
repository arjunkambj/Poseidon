import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import { PluginContents, PluginId, PluginsState, PoseidonPlugin } from "./plugins";
import { PoseidonRpcGroup, RPC_METHODS } from "./rpc";

const emptyContents = { skills: [], mcpServers: [], commands: 0, agents: 0, hooks: false };

const browser = {
  pluginId: "builtin:browser",
  name: "browser",
  description: "Drive Poseidon's in-app browser.",
  version: "1.0.0",
  source: "builtin",
  path: "/home/me/.poseidon/builtin-plugins/browser",
  enabled: true,
  contents: {
    skills: [{ name: "poseidon-browser", description: "Use the in-app browser." }],
    mcpServers: ["poseidon-browser"],
    commands: 0,
    agents: 0,
    hooks: false,
  },
};

const broken = {
  pluginId: "global:half-done",
  name: "half-done",
  source: "global",
  path: "/home/me/.poseidon/plugins/half-done",
  enabled: false,
  contents: emptyContents,
  error: ".claude-plugin/plugin.json is not valid JSON",
};

describe("PoseidonPlugin", () => {
  const decode = Schema.decodeUnknownExit(PoseidonPlugin);

  it("decodes a built-in plugin with its skills and MCP servers", () => {
    expect(decode(browser)._tag).toBe("Success");
  });

  it("decodes a plugin that failed validation, carrying its error and warnings", () => {
    const exit = decode({ ...broken, warnings: ["skills/draft has no SKILL.md"] });
    expect(exit._tag).toBe("Success");
  });

  it("rejects a source it does not know and an id without one", () => {
    expect(decode({ ...browser, source: "marketplace" })._tag).toBe("Failure");
    expect(decode({ ...browser, pluginId: "browser" })._tag).toBe("Failure");
    expect(decode({ ...browser, pluginId: "builtin:" })._tag).toBe("Failure");
  });

  it("keeps counts whole and non-negative", () => {
    const contents = Schema.decodeUnknownExit(PluginContents);
    expect(contents({ ...emptyContents, commands: 3, agents: 1, hooks: true })._tag).toBe(
      "Success",
    );
    expect(contents({ ...emptyContents, commands: -1 })._tag).toBe("Failure");
    expect(contents({ ...emptyContents, agents: 1.5 })._tag).toBe("Failure");
    expect(contents({ ...emptyContents, mcpServers: [""] })._tag).toBe("Failure");
  });
});

describe("PluginsState", () => {
  it("round-trips the global folder with valid and invalid plugins", () => {
    const state = { globalDir: "/home/me/.poseidon/plugins", plugins: [browser, broken] };
    const decoded = Schema.decodeUnknownSync(PluginsState)(state);
    const encoded = Schema.encodeUnknownSync(PluginsState)(decoded);
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(state);
  });
});

describe("plugin RPCs", () => {
  it("are plain requests in the group", () => {
    for (const method of [
      RPC_METHODS.pluginsList,
      RPC_METHODS.pluginsSetEnabled,
      RPC_METHODS.pluginsOpenFolder,
    ]) {
      const rpc = PoseidonRpcGroup.requests.get(method);
      expect(rpc, method).toBeDefined();
      expect(RpcSchema.isStreamSchema(rpc!.successSchema)).toBe(false);
    }
  });

  it("name the plugin to switch by its id", () => {
    const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.pluginsSetEnabled)!;
    const payload = Schema.decodeUnknownExit(rpc.payloadSchema);
    expect(payload({ pluginId: "global:notes", enabled: false })._tag).toBe("Success");
    expect(payload({ pluginId: "notes", enabled: false })._tag).toBe("Failure");
    expect(Schema.decodeUnknownExit(PluginId)("builtin:browser")._tag).toBe("Success");
  });
});
