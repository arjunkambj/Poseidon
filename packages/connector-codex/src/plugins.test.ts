/**
 * Poseidon's enabled plugins as a Codex session takes them: the skill roots
 * for `skills/extraRoots/set`, and the MCP servers as the thread's config.
 */

import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";
import { describe, expect, it } from "vitest";

import {
  pluginMcpClashWarning,
  pluginMcpKey,
  pluginSkillRoots,
  pluginThreadConfig,
} from "./plugins";

const plugin = (
  overrides: Partial<SessionPlugin> & Pick<SessionPlugin, "name">,
): SessionPlugin => ({
  root: `/plugins/${overrides.name}`,
  builtin: false,
  skills: [],
  skillsDirs: [],
  mcpServers: [],
  ...overrides,
});

describe("pluginSkillRoots", () => {
  it("lists every plugin's skill directories once, in order", () => {
    expect(
      pluginSkillRoots([
        plugin({ name: "a", skillsDirs: ["/plugins/a/skills", "/shared/skills"] }),
        plugin({ name: "b", skillsDirs: ["/shared/skills", "/plugins/b/skills/one"] }),
        plugin({ name: "c" }),
      ]),
    ).toEqual(["/plugins/a/skills", "/shared/skills", "/plugins/b/skills/one"]);
  });
});

describe("pluginThreadConfig", () => {
  it("names each server under its plugin, one dotted key each, so poseidon's entry stays", () => {
    expect(
      pluginThreadConfig([
        plugin({
          name: "tools",
          mcpServers: [
            {
              name: "local",
              transport: "stdio",
              command: "/bin/serve",
              args: ["--stdio"],
              env: { TOKEN: "t" },
            },
            {
              name: "remote",
              transport: "http",
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer x" },
            },
          ],
        }),
      ]),
    ).toEqual({
      "mcp_servers.plugin-tools-local": {
        command: "/bin/serve",
        args: ["--stdio"],
        env: { TOKEN: "t" },
      },
      "mcp_servers.plugin-tools-remote": {
        url: "https://example.com/mcp",
        http_headers: { Authorization: "Bearer x" },
      },
    });
  });

  it("is absent when no plugin has a server it can run, and keeps the first of a key", () => {
    expect(pluginThreadConfig([])).toBeUndefined();
    expect(
      pluginThreadConfig([
        plugin({ name: "p", mcpServers: [{ name: "s", transport: "http" }] }),
        plugin({ name: "q", mcpServers: [{ name: "s", transport: "stdio" }] }),
      ]),
    ).toBeUndefined();
    expect(
      pluginThreadConfig([
        plugin({ name: "p", mcpServers: [{ name: "s", transport: "stdio", command: "one" }] }),
        plugin({ name: "p", mcpServers: [{ name: "s", transport: "stdio", command: "two" }] }),
      ]),
    ).toEqual({ "mcp_servers.plugin-p-s": { command: "one" } });
  });
});

describe("pluginMcpClashWarning", () => {
  it("names a server whose key another plugin's server took first", () => {
    const run = { transport: "stdio", command: "serve" } as const;
    expect(
      pluginMcpClashWarning([
        plugin({ name: "a-b", mcpServers: [{ name: "c", ...run }] }),
        plugin({ name: "a", mcpServers: [{ name: "b-c", ...run }] }),
        plugin({ name: "my.tools", mcpServers: [{ name: "s", ...run }] }),
        plugin({ name: "my_tools", mcpServers: [{ name: "s", ...run }] }),
      ]),
    ).toBe(
      "Codex did not start these plugin MCP servers, whose names clash with another's: a/b-c (plugin-a-b-c is a-b/c's), my_tools/s (plugin-my_tools-s is my.tools/s's).",
    );
  });

  it("is absent when every key is its own, or the same server is listed twice", () => {
    const run = { transport: "stdio", command: "serve" } as const;
    expect(
      pluginMcpClashWarning([
        plugin({ name: "p", mcpServers: [{ name: "s", ...run }] }),
        plugin({ name: "p", mcpServers: [{ name: "s", ...run }] }),
        plugin({ name: "q", mcpServers: [{ name: "s", ...run }] }),
      ]),
    ).toBeUndefined();
  });
});

describe("pluginMcpKey", () => {
  it("keeps to the characters the CLI allows in a server name", () => {
    expect(pluginMcpKey("docs", "search.v2 beta")).toBe("plugin-docs-search_v2_beta");
    expect(pluginMcpKey("docs", "poseidon")).toBe("plugin-docs-poseidon");
  });
});
