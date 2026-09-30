/**
 * The pieces of the MCP servers extension that run no CLI: reading the
 * entries the real CLI wrote (`fixtures/claude/mcp-servers/config-files.json`),
 * the `claude mcp` argv, and every refusal that is decided before the CLI
 * would run — conflicts, scopes, a missing or unreadable config, the ledger.
 * The extension driven end to end is `mcpServersRecorded.test.ts`.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { McpServerConfig } from "@poseidon/contracts/connectors";
import { fixturesRoot } from "@poseidon/testkit/recording";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { Ran, RunClaude } from "./cli";
import { CLAUDE_KIND } from "./kind";
import {
  addArgs,
  addJson,
  claudeJsonPath,
  LEDGER_FILE,
  makeClaudeMcpServers,
  refusal,
  removeArgs,
  toMcpServerConfig,
} from "./mcpServers";

/** Every entry the CLI left in either file after any launch of the recording, by scope and name. */
const recordedEntries = (): ReadonlyMap<string, unknown> => {
  const kept = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(fixturesRoot(CLAUDE_KIND), "mcp-servers", "config-files.json"),
      "utf8",
    ),
  ) as ReadonlyArray<{
    user: Record<string, unknown>;
    project: { mcpServers: Record<string, unknown> };
  }>;
  const out = new Map<string, unknown>();
  for (const files of kept) {
    for (const [name, entry] of Object.entries(files.user)) out.set(`user:${name}`, entry);
    for (const [name, entry] of Object.entries(files.project.mcpServers)) {
      out.set(`project:${name}`, entry);
    }
  }
  return out;
};

const WEB: McpServerConfig = {
  name: "web",
  scope: "user",
  enabled: true,
  transport: "http",
  url: "http://127.0.0.1:9/web",
  headers: { Authorization: "Bearer ${TOKEN}" },
};

describe("toMcpServerConfig", () => {
  it("reads every entry the CLI wrote: http with a header, stdio with args and env, bare stdio", () => {
    const entries = recordedEntries();
    const read = (key: string) => {
      const [scope, name] = key.split(":") as ["user" | "project", string];
      return toMcpServerConfig(name, scope, entries.get(key), false);
    };
    expect(read("user:hand-made")).toEqual({
      name: "hand-made",
      scope: "user",
      enabled: true,
      managed: false,
      transport: "http",
      url: "http://127.0.0.1:9/hand",
      headers: { "X-Team": "${TEAM_TOKEN}" },
    });
    expect(read("user:local")).toEqual({
      name: "local",
      scope: "user",
      enabled: true,
      managed: false,
      transport: "stdio",
      command: "true",
      args: ["--flag", "two words"],
      env: { MODE: "test" },
    });
    // The CLI writes `args: []` for a server with none; it is left out.
    expect(entries.get("project:proj")).toEqual({ type: "stdio", command: "true", args: [] });
    expect(read("project:proj")).toEqual({
      name: "proj",
      scope: "project",
      enabled: true,
      managed: false,
      transport: "stdio",
      command: "true",
    });
    expect(read("project:hand-project")?.transport).toBe("stdio");
  });

  it("carries the ledger's verdict on ownership", () => {
    expect(toMcpServerConfig("x", "user", { command: "true" }, true)?.managed).toBe(true);
  });

  it("shows an sse server as http, and drops what it cannot show", () => {
    expect(toMcpServerConfig("s", "user", { type: "sse", url: "http://h/sse" }, false)).toEqual({
      name: "s",
      scope: "user",
      enabled: true,
      managed: false,
      transport: "http",
      url: "http://h/sse",
    });
    expect(toMcpServerConfig("x", "user", null, false)).toBeNull();
    expect(toMcpServerConfig("x", "user", { type: "ws", url: "ws://h" }, false)).toBeNull();
    expect(toMcpServerConfig("x", "user", { type: "stdio" }, false)).toBeNull();
    expect(toMcpServerConfig("x", "user", { type: "http" }, false)).toBeNull();
    expect(toMcpServerConfig("x", "user", { url: "http://h" }, false)).toBeNull();
  });
});

describe("the claude mcp argv", () => {
  it("puts the name after --, so one that looks like a flag stays the server's", () => {
    expect(addArgs("project", "-x", "{}")).toEqual([
      "mcp",
      "add-json",
      "--scope",
      "project",
      "--",
      "-x",
      "{}",
    ]);
    expect(removeArgs("user", "-x")).toEqual(["mcp", "remove", "--scope", "user", "--", "-x"]);
  });

  it("writes an entry in the shape the CLI stores, leaving empty parts out", () => {
    expect(JSON.parse(addJson(WEB))).toEqual({
      type: "http",
      url: "http://127.0.0.1:9/web",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
    expect(
      JSON.parse(
        addJson({
          name: "s",
          scope: "user",
          enabled: true,
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
        }),
      ),
    ).toEqual({ type: "stdio", command: "node" });
  });

  it("refuses what the CLI cannot express", () => {
    expect(refusal(WEB)).toBeNull();
    expect(refusal({ ...WEB, enabled: false })).toContain("/mcp");
    expect(refusal({ ...WEB, name: "poseidon" })).toContain("Poseidon's own MCP server");
    expect(refusal({ name: "s", scope: "user", enabled: true, transport: "stdio" })).toContain(
      "command",
    );
    expect(refusal({ name: "h", scope: "user", enabled: true, transport: "http" })).toContain(
      "url",
    );
  });
});

describe("claudeJsonPath", () => {
  it("is in the instance's config dir, else beside the home directory", () => {
    expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: "/c", HOME: "/h" })).toBe("/c/.claude.json");
    expect(claudeJsonPath({ HOME: "/h" })).toBe("/h/.claude.json");
  });
});

// ── The extension, with no CLI to run ──────────────────────────

/** A runner the test fails on: every case here is decided before the CLI would run. */
const never: RunClaude = (args) => Effect.die(new Error(`ran claude ${args.join(" ")}`));

const scratch = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-mcp-unit-"));
  const configDir = NodePath.join(root, "config");
  const workspace = NodePath.join(root, "workspace");
  NodeFS.mkdirSync(configDir);
  NodeFS.mkdirSync(workspace);
  const write = (path: string, value: unknown) =>
    NodeFS.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return {
    configDir,
    workspace,
    userFile: (value: unknown) => write(NodePath.join(configDir, ".claude.json"), value),
    projectFile: (value: unknown) => write(NodePath.join(workspace, ".mcp.json"), value),
    ledger: (value: unknown) => write(NodePath.join(configDir, LEDGER_FILE), value),
    extension: (run: RunClaude = never) =>
      makeClaudeMcpServers({
        env: { CLAUDE_CONFIG_DIR: configDir },
        run,
        writeMutex: Semaphore.makeUnsafe(1),
      }),
  };
};

const HAND = { type: "stdio", command: "true" };

describe("the Claude Code MCP servers extension", () => {
  it.effect("lists nothing when neither file exists", () =>
    Effect.gen(function* () {
      const at = scratch();
      expect(yield* at.extension().list({ workspaceRoot: at.workspace })).toEqual([]);
      // The CLI's own file keeps more than servers; only `mcpServers` is read.
      at.userFile({ numStartups: 3, projects: { "/p": { mcpServers: { local: HAND } } } });
      expect(yield* at.extension().list({ workspaceRoot: null })).toEqual([]);
    }),
  );

  it.effect("lists a project's servers only with a project", () =>
    Effect.gen(function* () {
      const at = scratch();
      at.userFile({ mcpServers: { mine: HAND } });
      at.projectFile({ mcpServers: { theirs: HAND } });
      const names = (servers: ReadonlyArray<McpServerConfig>) =>
        servers.map((server) => `${server.scope}:${server.name}`);
      expect(names(yield* at.extension().list({ workspaceRoot: null }))).toEqual(["user:mine"]);
      expect(names(yield* at.extension().list({ workspaceRoot: at.workspace }))).toEqual([
        "user:mine",
        "project:theirs",
      ]);
    }),
  );

  it.effect("refuses a project server without a project", () =>
    Effect.gen(function* () {
      const at = scratch();
      const mcp = at.extension();
      const add = yield* Effect.flip(
        mcp.add({ workspaceRoot: null }, { ...WEB, scope: "project" }),
      );
      expect(add.code).toBe("not-found");
      const remove = yield* Effect.flip(mcp.remove({ workspaceRoot: null }, "project", "web"));
      expect(remove.code).toBe("not-found");
    }),
  );

  it.effect("never overwrites or removes a server it did not add, in either scope", () =>
    Effect.gen(function* () {
      const at = scratch();
      at.userFile({ mcpServers: { web: HAND } });
      at.projectFile({ mcpServers: { web: HAND } });
      const mcp = at.extension();
      const scope = { workspaceRoot: at.workspace };
      expect((yield* Effect.flip(mcp.add(scope, WEB))).code).toBe("conflict");
      expect((yield* Effect.flip(mcp.add(scope, { ...WEB, scope: "project" }))).code).toBe(
        "conflict",
      );
      expect((yield* Effect.flip(mcp.remove(scope, "user", "web"))).code).toBe("conflict");
      expect((yield* Effect.flip(mcp.remove(scope, "project", "web"))).code).toBe("conflict");
      // A name no scope holds is not found, rather than refused.
      expect((yield* Effect.flip(mcp.remove(scope, "user", "gone"))).code).toBe("not-found");
    }),
  );

  it.effect("keeps the ledger per scope and per workspace", () =>
    Effect.gen(function* () {
      const at = scratch();
      at.userFile({ mcpServers: { web: HAND } });
      at.projectFile({ mcpServers: { web: HAND } });
      // Ours in another workspace's project scope: not in this one's, nor the user's.
      at.ledger({ user: [], projects: { "/elsewhere": ["web"] } });
      const mcp = at.extension();
      const listed = yield* mcp.list({ workspaceRoot: at.workspace });
      expect(listed.map((server) => server.managed)).toEqual([false, false]);
      expect(
        (yield* Effect.flip(mcp.remove({ workspaceRoot: at.workspace }, "project", "web"))).code,
      ).toBe("conflict");

      at.ledger({ user: ["web"], projects: { [at.workspace]: ["web"] } });
      const both = yield* mcp.list({ workspaceRoot: at.workspace });
      expect(both.map((server) => server.managed)).toEqual([true, true]);
    }),
  );

  it.effect("counts an unreadable ledger as empty, so nothing can be removed", () =>
    Effect.gen(function* () {
      const at = scratch();
      at.userFile({ mcpServers: { web: HAND } });
      at.ledger("{ not json");
      const mcp = at.extension();
      expect((yield* mcp.list({ workspaceRoot: null }))[0]?.managed).toBe(false);
      expect((yield* Effect.flip(mcp.remove({ workspaceRoot: null }, "user", "web"))).code).toBe(
        "conflict",
      );
    }),
  );

  it.effect("lists nothing from a file it cannot parse, and has the CLI write none to it", () =>
    Effect.gen(function* () {
      const at = scratch();
      at.userFile('{"mcpServers": {"web": {"command": "true"}}, broken');
      at.projectFile({ mcpServers: { theirs: HAND } });
      at.ledger({ user: ["web"], projects: {} });
      const mcp = at.extension();
      const scope = { workspaceRoot: at.workspace };
      // The project's servers are still listed; the user's cannot be.
      expect((yield* mcp.list(scope)).map((server) => server.name)).toEqual(["theirs"]);
      // The CLI would back the file up and start a fresh one: refused first.
      const add = yield* Effect.flip(mcp.add(scope, { ...WEB, name: "new" }));
      expect(add.code).toBe("conflict");
      expect(add.message).toContain(".claude.json");
      const remove = yield* Effect.flip(mcp.remove(scope, "user", "web"));
      expect(remove.code).toBe("conflict");

      at.projectFile("[1, 2]");
      const project = yield* Effect.flip(mcp.add(scope, { ...WEB, scope: "project" }));
      expect(project.code).toBe("conflict");
      expect(project.message).toContain(".mcp.json");
    }),
  );

  it.effect("puts an edited server back as it was when the CLI refuses the new entry", () =>
    Effect.gen(function* () {
      const at = scratch();
      const before = { type: "http", url: "http://127.0.0.1:9/old" };
      at.userFile({ mcpServers: { web: before } });
      at.ledger({ user: ["web"], projects: {} });
      const ran: Array<ReadonlyArray<string>> = [];
      const answers: ReadonlyArray<Ran> = [
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "refused" },
        { code: 0, stdout: "", stderr: "" },
      ];
      const run: RunClaude = (args) =>
        Effect.sync(() => {
          ran.push(args);
          return answers[ran.length - 1]!;
        });
      const failure = yield* Effect.flip(at.extension(run).add({ workspaceRoot: null }, WEB));
      expect(failure).toMatchObject({ code: "invalid", message: "refused" });
      expect(ran).toEqual([
        removeArgs("user", "web"),
        addArgs("user", "web", addJson(WEB)),
        addArgs("user", "web", JSON.stringify(before)),
      ]);
      const ledger = JSON.parse(
        NodeFS.readFileSync(NodePath.join(at.configDir, LEDGER_FILE), "utf8"),
      ) as unknown;
      expect(ledger).toEqual({ user: ["web"], projects: {} });
    }),
  );
});
