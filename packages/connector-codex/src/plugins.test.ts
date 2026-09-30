/**
 * Poseidon's enabled plugins as a Codex session takes them: the skill roots
 * for `skills/extraRoots/set`, and the MCP servers as the thread's config.
 */

import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";
import { describe, expect, it } from "vitest";

import { pluginMcpKey, pluginSkillRoots, pluginThreadConfig } from "./plugins";

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
  it("names each server under its plugin, in the CLI's own table", () => {
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
      mcp_servers: {
        "plugin-tools-local": { command: "/bin/serve", args: ["--stdio"], env: { TOKEN: "t" } },
        "plugin-tools-remote": {
          url: "https://example.com/mcp",
          http_headers: { Authorization: "Bearer x" },
        },
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
    ).toEqual({ mcp_servers: { "plugin-p-s": { command: "one" } } });
  });
});

describe("pluginMcpKey", () => {
  it("keeps to the characters the CLI allows in a server name", () => {
    expect(pluginMcpKey("docs", "search.v2 beta")).toBe("plugin-docs-search_v2_beta");
    expect(pluginMcpKey("docs", "poseidon")).toBe("plugin-docs-poseidon");
  });
});
