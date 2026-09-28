/**
 * Claude Code's installed plugins, read from `fixtures/claude/plugins/`: the
 * files the real CLI wrote when it installed one plugin for the user (then
 * disabled it) and one for a project. Each test works on a temporary copy with
 * the scrubbed paths put back, so nothing reads or writes a real `~/.claude`.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { fixturesRoot } from "@poseidon/testkit/recording";
import * as Effect from "effect/Effect";

import { claudeConfigDir, makeClaudePlugins } from "./plugins";
import { CLAUDE_KIND } from "./kind";

const FIXTURE = NodePath.join(fixturesRoot(CLAUDE_KIND), "plugins");
const INSTALLED = NodePath.join("plugins", "installed_plugins.json");

/** A temporary copy of the fixture, its placeholders pointing into it. */
const copyFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-plugins-"));
  NodeFS.cpSync(FIXTURE, root, { recursive: true });
  const config = NodePath.join(root, "config");
  const project = NodePath.join(root, "project");
  for (const file of [
    NodePath.join(config, INSTALLED),
    NodePath.join(config, "settings.json"),
    NodePath.join(project, ".claude", "settings.json"),
  ]) {
    const text = NodeFS.readFileSync(file, "utf8")
      .replaceAll("<config>", config)
      .replaceAll("<project>", project)
      .replaceAll("<market>", NodePath.join(root, "market"));
    NodeFS.writeFileSync(file, text);
  }
  return { root, config, project };
};

const listIn = (config: string, workspaceRoot: string | null) =>
  makeClaudePlugins({ env: { CLAUDE_CONFIG_DIR: config } }).list({ workspaceRoot });

describe("makeClaudePlugins", () => {
  it.effect("lists the user's installs alone when no project is asked", () =>
    Effect.gen(function* () {
      const { config } = copyFixture();
      expect(yield* listIn(config, null)).toEqual([
        {
          name: "agent-sdk-dev",
          description: "Claude Agent SDK Development Plugin",
          source: "poseidon-fixtures",
          scope: "user",
          // `claude plugin disable` wrote `false` into the user settings.
          enabled: false,
        },
      ]);
    }),
  );

  it.effect("adds a project's own installs in that project, enabled by its settings", () =>
    Effect.gen(function* () {
      const { config, project } = copyFixture();
      const plugins = yield* listIn(config, project);
      expect(plugins.map((plugin) => [plugin.name, plugin.scope, plugin.enabled])).toEqual([
        ["agent-sdk-dev", "user", false],
        ["commit-commands", "project", true],
      ]);
      expect(plugins[1]?.description).toMatch(/^Streamline your git workflow/);
      expect(plugins[1]?.source).toBe("poseidon-fixtures");
    }),
  );

  it.effect("leaves another project's installs out", () =>
    Effect.gen(function* () {
      const { root, config } = copyFixture();
      const elsewhere = NodePath.join(root, "elsewhere");
      NodeFS.mkdirSync(elsewhere);
      const plugins = yield* listIn(config, elsewhere);
      expect(plugins.map((plugin) => plugin.name)).toEqual(["agent-sdk-dev"]);
    }),
  );

  it.effect("overlays the project's settings.local.json last", () =>
    Effect.gen(function* () {
      const { config, project } = copyFixture();
      NodeFS.writeFileSync(
        NodePath.join(project, ".claude", "settings.local.json"),
        JSON.stringify({
          enabledPlugins: {
            "agent-sdk-dev@poseidon-fixtures": true,
            "commit-commands@poseidon-fixtures": false,
          },
        }),
      );
      const inProject = yield* listIn(config, project);
      expect(inProject.map((plugin) => [plugin.name, plugin.enabled])).toEqual([
        ["agent-sdk-dev", true],
        ["commit-commands", false],
      ]);
      // The user scope still reads the user settings alone.
      expect((yield* listIn(config, null))[0]?.enabled).toBe(false);
    }),
  );

  it.effect("treats a plugin no settings file names as enabled", () =>
    Effect.gen(function* () {
      const { config } = copyFixture();
      NodeFS.rmSync(NodePath.join(config, "settings.json"));
      expect((yield* listIn(config, null))[0]?.enabled).toBe(true);
    }),
  );

  it.effect("leaves the description out when the plugin has no manifest", () =>
    Effect.gen(function* () {
      const { config } = copyFixture();
      NodeFS.rmSync(
        NodePath.join(config, "plugins", "cache", "poseidon-fixtures", "agent-sdk-dev"),
        { recursive: true },
      );
      const [plugin] = yield* listIn(config, null);
      expect(plugin?.name).toBe("agent-sdk-dev");
      expect(plugin).not.toHaveProperty("description");
    }),
  );

  it.effect("answers none when nothing is installed", () =>
    Effect.gen(function* () {
      const empty = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-plugins-"));
      expect(yield* listIn(empty, null)).toEqual([]);
    }),
  );

  it.effect("answers none for a layout it does not know", () =>
    Effect.gen(function* () {
      const { config } = copyFixture();
      NodeFS.writeFileSync(
        NodePath.join(config, INSTALLED),
        JSON.stringify({ version: 1, plugins: { "agent-sdk-dev@poseidon-fixtures": {} } }),
      );
      expect(yield* listIn(config, null)).toEqual([]);
    }),
  );

  it.effect("fails with the file's path when it is not JSON", () =>
    Effect.gen(function* () {
      const { config } = copyFixture();
      NodeFS.writeFileSync(NodePath.join(config, INSTALLED), "{ not json");
      const error = yield* Effect.flip(listIn(config, null));
      expect(error.code).toBe("internal");
      expect(error.message).toContain(NodePath.join(config, INSTALLED));
    }),
  );
});

describe("claudeConfigDir", () => {
  it("is CLAUDE_CONFIG_DIR when the instance sets one, else ~/.claude", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/accounts/work", HOME: "/home/me" })).toBe(
      "/accounts/work",
    );
    expect(claudeConfigDir({ HOME: "/home/me" })).toBe(NodePath.join("/home/me", ".claude"));
  });
});
