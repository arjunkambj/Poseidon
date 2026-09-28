/**
 * Reading one plugin directory. Every plugin here is written into a fresh
 * temporary folder in the Claude Code layout, the shape an existing Claude
 * Code plugin already has on disk.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { readPlugin } from "./manifest";

/** Writes `files` (relative path → content) under a new plugin folder. */
const plugin = (name: string, files: Record<string, string>): string => {
  const root = join(mkdtempSync(join(tmpdir(), "poseidon-plugin-")), name);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

describe("readPlugin", () => {
  it("reads a Claude-style plugin with every component", async () => {
    const root = plugin("review-kit", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "review-kit",
        description: "Review helpers",
        version: "1.2.0",
        author: { name: "Someone" },
      }),
      "skills/triage/SKILL.md": skill("triage", "Sort findings by severity"),
      "skills/summarize/SKILL.md": `---\nname: summarize\ndescription: >-\n  Summarize a diff\n  in two lines\n---\n`,
      "skills/notes.txt": "not a skill",
      "commands/review.md": "# review",
      "commands/nested/deep.md": "# deep",
      "commands/readme.txt": "ignored",
      "agents/reviewer.md": "# reviewer",
      "hooks/hooks.json": "{}",
      ".mcp.json": JSON.stringify({
        mcpServers: {
          local: {
            command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
            args: ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json", "${HOME}/x"],
            env: { DATA: "${POSEIDON_PLUGIN_ROOT}/data" },
          },
          remote: { type: "http", url: "https://example.test/mcp", headers: { A: "b" } },
        },
      }),
    });

    const { plugin: listed, session } = await readPlugin(root, "global");

    expect(listed).toEqual({
      pluginId: "global:review-kit",
      name: "review-kit",
      description: "Review helpers",
      version: "1.2.0",
      source: "global",
      path: root,
      enabled: true,
      contents: {
        skills: [
          { name: "summarize", description: "Summarize a diff in two lines" },
          { name: "triage", description: "Sort findings by severity" },
        ],
        mcpServers: ["local", "remote"],
        commands: 2,
        agents: 1,
        hooks: true,
      },
    });
    expect(session).toEqual({
      name: "review-kit",
      root,
      builtin: false,
      skills: [
        {
          name: "summarize",
          description: "Summarize a diff in two lines",
          path: join(root, "skills", "summarize"),
        },
        {
          name: "triage",
          description: "Sort findings by severity",
          path: join(root, "skills", "triage"),
        },
      ],
      skillsDirs: [join(root, "skills")],
      mcpServers: [
        {
          name: "local",
          transport: "stdio",
          command: `${root}/bin/server`,
          args: ["--config", `${root}/config.json`, "${HOME}/x"],
          env: { DATA: `${root}/data` },
        },
        {
          name: "remote",
          transport: "http",
          url: "https://example.test/mcp",
          headers: { A: "b" },
        },
      ],
    });
  });

  it("reads a flat .mcp.json and names a plugin without plugin.json after its folder", async () => {
    const root = plugin("just-mcp", {
      ".mcp.json": JSON.stringify({ tool: { command: "npx", args: ["-y", "tool"] } }),
    });

    const { plugin: listed, session } = await readPlugin(root, "global");

    expect(listed.error).toBeUndefined();
    expect(listed.name).toBe("just-mcp");
    expect(listed.description).toBeUndefined();
    expect(listed.contents.mcpServers).toEqual(["tool"]);
    expect(session?.mcpServers).toEqual([
      { name: "tool", transport: "stdio", command: "npx", args: ["-y", "tool"], env: {} },
    ]);
  });

  it("follows custom skills, commands and mcpServers paths in plugin.json", async () => {
    const root = plugin("custom", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "custom",
        skills: ["./extra-skills", "./single"],
        commands: "./cmds",
        mcpServers: "./config/servers.json",
      }),
      "skills/base/SKILL.md": skill("base", "Base skill"),
      "extra-skills/more/SKILL.md": skill("more", "More skill"),
      "single/SKILL.md": skill("single", "One skill folder"),
      "commands/ignored.md": "# replaced by cmds",
      "cmds/a.md": "# a",
      "cmds/b.md": "# b",
      "config/servers.json": JSON.stringify({
        mcpServers: { svc: { type: "http", url: "${CLAUDE_PLUGIN_ROOT}/sock" } },
      }),
    });

    const { plugin: listed, session } = await readPlugin(root, "global");

    expect(listed.error).toBeUndefined();
    expect(listed.contents.skills.map((entry) => entry.name)).toEqual(["base", "more", "single"]);
    expect(listed.contents.commands).toBe(2);
    // A single skill folder is a skills directory too, so a harness that only
    // takes directories still loads it.
    expect(session?.skillsDirs).toEqual([
      join(root, "skills"),
      join(root, "extra-skills"),
      join(root, "single"),
    ]);
    expect(session?.mcpServers).toEqual([
      { name: "svc", transport: "http", url: `${root}/sock`, headers: {} },
    ]);
  });

  it("accepts mcpServers inline in plugin.json", async () => {
    const root = plugin("inline", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "inline",
        mcpServers: { db: { command: "${CLAUDE_PLUGIN_ROOT}/db" } },
      }),
    });

    const { session } = await readPlugin(root, "global");

    expect(session?.mcpServers).toEqual([
      { name: "db", transport: "stdio", command: `${root}/db`, args: [], env: {} },
    ]);
  });

  it("lists invalid JSON in plugin.json as an error", async () => {
    const root = plugin("broken", { ".claude-plugin/plugin.json": "{ nope" });

    const { plugin: listed, session } = await readPlugin(root, "global");

    expect(session).toBeNull();
    expect(listed.pluginId).toBe("global:broken");
    expect(listed.name).toBe("broken");
    expect(listed.enabled).toBe(false);
    expect(listed.error).toMatch(/^invalid plugin\.json: /);
    expect(listed.contents).toEqual({
      skills: [],
      mcpServers: [],
      commands: 0,
      agents: 0,
      hooks: false,
    });
  });

  it("rejects a name that is not kebab-case, and a missing one", async () => {
    const badName = plugin("bad-name", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "Bad Name" }),
    });
    const noName = plugin("no-name", {
      ".claude-plugin/plugin.json": JSON.stringify({ description: "x" }),
    });

    expect((await readPlugin(badName, "global")).plugin.error).toBe(
      'invalid plugin.json: name "Bad Name" must be kebab-case',
    );
    expect((await readPlugin(noName, "global")).plugin.error).toBe(
      "invalid plugin.json: name is required",
    );
  });

  it("refuses a manifest path that leaves the plugin folder", async () => {
    const root = plugin("escape", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "escape", skills: "../elsewhere" }),
    });

    const { plugin: listed, session } = await readPlugin(root, "global");

    expect(session).toBeNull();
    expect(listed.error).toBe('path "../elsewhere" leaves the plugin folder');
  });

  it("skips an sse server with a warning and keeps the rest", async () => {
    const root = plugin("mixed", {
      ".mcp.json": JSON.stringify({
        old: { type: "sse", url: "https://example.test/sse" },
        good: { command: "run" },
        odd: { type: "websocket", url: "ws://x" },
      }),
    });

    const { plugin: listed } = await readPlugin(root, "global");

    expect(listed.error).toBeUndefined();
    expect(listed.contents.mcpServers).toEqual(["good"]);
    expect(listed.warnings).toEqual([
      'MCP server "old" uses the sse transport, which Poseidon does not load',
      'MCP server "odd" uses the websocket transport, which Poseidon does not load',
    ]);
  });

  it("warns about a skill without a description or with a mismatched name", async () => {
    const root = plugin("skills-only", {
      "skills/one/SKILL.md": "---\nname: other\n---\n",
    });

    const { plugin: listed } = await readPlugin(root, "global");

    expect(listed.contents.skills).toEqual([{ name: "one" }]);
    expect(listed.warnings).toEqual([
      'skill "one" is named "other" in its SKILL.md',
      'skill "one" has no description',
    ]);
  });

  it("says a folder with no manifest and no components is not a plugin", async () => {
    const root = plugin("random", { "README.md": "hello" });

    const { plugin: listed, session } = await readPlugin(root, "global");

    expect(session).toBeNull();
    expect(listed.error).toBe("not a plugin");
  });

  it("lists an unparseable .mcp.json as an error", async () => {
    const root = plugin("bad-mcp", { ".mcp.json": "[1, 2]" });

    const { plugin: listed } = await readPlugin(root, "global");

    expect(listed.error).toBe("invalid .mcp.json: it must be an object of MCP servers");
  });

  it("marks a built-in plugin as built in", async () => {
    const root = plugin("browser", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "browser" }),
      "skills/browser/SKILL.md": skill("browser", "Use the browser"),
    });

    const { plugin: listed, session } = await readPlugin(root, "builtin");

    expect(listed.pluginId).toBe("builtin:browser");
    expect(listed.source).toBe("builtin");
    expect(session?.builtin).toBe(true);
  });
});
