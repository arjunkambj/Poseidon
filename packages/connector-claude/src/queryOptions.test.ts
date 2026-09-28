import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";
import { describe, expect, it } from "vitest";

import { pluginMcpKey } from "./pluginOptions";
import { buildQueryOptions, sdkEffortFor, type QueryOptionsInput } from "./queryOptions";
import type { ToolGate } from "./toolGate";

/** Never called: the options only wrap the gate's doors in closures. */
const gate: ToolGate = {
  preToolUse: () => Promise.reject(new Error("not called")),
  canUseTool: () => Promise.reject(new Error("not called")),
  sightings: () => 0,
};

const input: QueryOptionsInput = {
  binaryPath: "/usr/local/bin/claude",
  env: { PATH: "/usr/bin" },
  cwd: "/work/project",
  sessionId: "11111111-1111-4111-8111-111111111111",
  settings: { model: "default", runtimeMode: "approval-required", interactionMode: "default" },
  mcp: { url: "http://127.0.0.1:4000/mcp/thread", bearer: "secret" },
  attachmentsDir: "/home/attachments/thread",
  abortController: new AbortController(),
  spawn: () => {
    throw new Error("not called");
  },
  gate,
};

const poseidonServer = {
  type: "http",
  url: "http://127.0.0.1:4000/mcp/thread",
  headers: { Authorization: "Bearer secret" },
};

const browser: SessionPlugin = {
  name: "browser",
  root: "/home/builtin-plugins/browser",
  builtin: true,
  skills: [{ name: "browser", path: "/home/builtin-plugins/browser/skills/browser" }],
  skillsDirs: ["/home/builtin-plugins/browser/skills"],
  mcpServers: [],
};

const tools: SessionPlugin = {
  name: "tools",
  root: "/home/plugins/tools",
  builtin: false,
  skills: [],
  skillsDirs: [],
  mcpServers: [
    {
      name: "search",
      transport: "http",
      url: "https://search.example/mcp",
      headers: { "X-Key": "k" },
    },
    {
      name: "local",
      transport: "stdio",
      command: "/home/plugins/tools/bin/server",
      args: ["--root", "/home/plugins/tools"],
      env: { MODE: "fast" },
    },
    // A plugin whose own server is named like ours still cannot replace it.
    { name: "poseidon", transport: "stdio", command: "/bin/true" },
  ],
};

describe("sdkEffortFor", () => {
  it("passes the CLI's rungs through and leaves out the ones it lacks", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(sdkEffortFor(effort)).toBe(effort);
    }
    expect(sdkEffortFor(undefined)).toBeUndefined();
    expect(sdkEffortFor("minimal")).toBeUndefined();
    expect(sdkEffortFor("ultra")).toBeUndefined();
  });

  it("never hands the CLI an ultra effort at launch", () => {
    const options = buildQueryOptions({
      ...input,
      settings: { ...input.settings, effort: "ultra" },
    });
    expect(options.effort).toBeUndefined();
    expect("effort" in options).toBe(false);
  });
});

describe("buildQueryOptions plugins", () => {
  it("adds nothing when no plugin is enabled", () => {
    for (const options of [
      buildQueryOptions(input),
      buildQueryOptions({ ...input, plugins: [] }),
    ]) {
      expect("plugins" in options).toBe(false);
      expect(options.mcpServers).toEqual({ poseidon: poseidonServer });
      expect(Object.keys(options.mcpServers ?? {})).toEqual(["poseidon"]);
    }
  });

  it("loads each enabled plugin as a local plugin with the CLI's own MCP discovery off", () => {
    const options = buildQueryOptions({ ...input, plugins: [browser, tools] });
    expect(options.plugins).toEqual([
      { type: "local", path: "/home/builtin-plugins/browser", skipMcpDiscovery: true },
      { type: "local", path: "/home/plugins/tools", skipMcpDiscovery: true },
    ]);
  });

  it("merges the plugins' MCP servers beside poseidon, which stays ours", () => {
    const options = buildQueryOptions({ ...input, plugins: [browser, tools] });
    expect(options.mcpServers).toEqual({
      [pluginMcpKey("tools", "search")]: {
        type: "http",
        url: "https://search.example/mcp",
        headers: { "X-Key": "k" },
      },
      "plugin-tools-local": {
        type: "stdio",
        command: "/home/plugins/tools/bin/server",
        args: ["--root", "/home/plugins/tools"],
        env: { MODE: "fast" },
      },
      "plugin-tools-poseidon": { type: "stdio", command: "/bin/true" },
      poseidon: poseidonServer,
    });
  });

  it("keeps the first of two servers that land on the same key", () => {
    const again: SessionPlugin = {
      ...tools,
      root: "/elsewhere/tools",
      mcpServers: [{ name: "search", transport: "http", url: "https://other.example/mcp" }],
    };
    const options = buildQueryOptions({ ...input, plugins: [tools, again] });
    expect(options.mcpServers?.["plugin-tools-search"]).toMatchObject({
      url: "https://search.example/mcp",
    });
  });
});
