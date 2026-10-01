/**
 * The MCP servers extension against the real CLI's recorded answers.
 *
 * `fixtures/claude/mcp-servers/` is this very script run through the testkit's
 * stdio tee against the operator's `claude`, on a scratch `CLAUDE_CONFIG_DIR`
 * and `HOME` whose `.claude.json` holds one user server written by hand, and
 * a scratch workspace whose `.mcp.json` holds one project server written by
 * hand: every `claude mcp add-json` and `remove` the extension ran, with what
 * the CLI printed and how it exited. The replay hands each launch the next
 * recorded one with the same argv, so a change in what the extension runs, or
 * in what order, fails here.
 *
 * The extension reads the two files rather than asking the CLI, so the
 * recording also keeps what the CLI left in them after each launch
 * (`config-files.json`): the `mcpServers` of `.claude.json`, the rest of which
 * is the CLI's own state and is not kept, and the whole of `.mcp.json`. The
 * replay puts both back after the launch they followed, as the CLI would have
 * left them.
 *
 *     POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude exec vitest run src/mcpServersRecorded.test.ts
 *
 * records it again. No session starts and no request is made, so it costs
 * nothing, and the operator's own config is never read or written.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { McpServerConfig } from "@poseidon/contracts/connectors";
import { fixturesRoot } from "@poseidon/testkit/recording";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { afterAll } from "vitest";

import { replay } from "../test/replay";
import { resolveBinary } from "./binary";
import { runClaude, type RunClaude } from "./cli";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { fingerprint, LEDGER_FILE, makeClaudeMcpServers } from "./mcpServers";
import { parseVersion } from "./probe";

const SCENARIO = "mcp-servers";
const CONFIG_FILES = "config-files.json";
const RECORD = process.env.POSEIDON_RECORD_CLAUDE === "1";

/** The servers the user configured themselves, before Poseidon touched anything. */
const HAND_MADE_USER = {
  "hand-made": {
    type: "http",
    url: "http://127.0.0.1:9/hand",
    headers: { "X-Team": "${TEAM_TOKEN}" },
  },
};
const HAND_MADE_PROJECT = { "hand-project": { command: "true", args: [] } };

/** What the CLI left in the two files after one launch. */
interface ConfigFiles {
  readonly file: string;
  readonly argv: ReadonlyArray<string>;
  /** `.claude.json`'s `mcpServers`. */
  readonly user: unknown;
  /** `.mcp.json`, whole; `null` while there is none. */
  readonly project: unknown;
}

const readJson = (path: string): unknown =>
  NodeFS.existsSync(path) ? (JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown) : null;

const seed = (root: string) => {
  const configDir = NodePath.join(root, "config");
  const workspace = NodePath.join(root, "workspace");
  const home = NodePath.join(root, "home");
  for (const dir of [configDir, workspace, home]) NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(configDir, ".claude.json"),
    `${JSON.stringify({ mcpServers: HAND_MADE_USER }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(workspace, ".mcp.json"),
    `${JSON.stringify({ mcpServers: HAND_MADE_PROJECT }, null, 2)}\n`,
  );
  return { configDir, workspace, home };
};

const recorder = () => {
  const real = resolveBinary({}, process.env);
  if (real === null) throw new Error("no claude binary to record");
  const cliVersion = parseVersion(execFileSync(real.command, ["--version"], { encoding: "utf8" }));
  const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `claude-${SCENARIO}-raw-`));
  const launcher = makeTeeLauncher({ realBinary: real.command, rawDir });
  const root = NodePath.join(NodeFS.realpathSync("/tmp"), "poseidon-claude-mcp");
  NodeFS.rmSync(root, { recursive: true, force: true });
  const dirs = seed(root);
  const inner = runClaude({
    binary: () => ({ command: launcher, display: launcher }),
    // A scratch HOME as well as the config dir: nothing of the operator's is read.
    env: () => childEnv({ ...process.env, HOME: dirs.home }, { configDir: dirs.configDir }),
  });
  const kept: Array<ConfigFiles> = [];
  const run: RunClaude = (args, cwd) =>
    Effect.tap(inner(args, cwd), () =>
      Effect.sync(() => {
        const claudeJson = readJson(NodePath.join(dirs.configDir, ".claude.json"));
        kept.push({
          file: `invocation-${kept.length + 1}.ndjson`,
          argv: args,
          user:
            typeof claudeJson === "object" && claudeJson !== null && "mcpServers" in claudeJson
              ? claudeJson.mcpServers
              : null,
          project: readJson(NodePath.join(dirs.workspace, ".mcp.json")),
        });
      }),
    );
  return {
    ...dirs,
    run,
    finish: () => {
      const dir = finalizeSdkStreamRecording({
        kind: CLAUDE_KIND,
        scenario: SCENARIO,
        rawDir,
        description:
          "The MCP servers extension on a scratch CLAUDE_CONFIG_DIR and workspace, each holding one hand-written server: claude mcp add-json (user http with a header variable, user stdio with env, a project server), an edit as remove and add-json, the refusals that run nothing, a name the CLI rejects, and two removes. config-files.json keeps what the CLI left in .claude.json's mcpServers and in .mcp.json after each launch.",
        cliVersion: cliVersion ?? "unknown",
        model: "default",
        prompts: [],
        scratch: root,
      });
      const text = `${JSON.stringify(kept, null, 2)}\n`;
      // The entries are this script's own; nothing of the machine may be in them.
      expect(text).not.toContain(root);
      expect(text).not.toContain(NodeOS.homedir());
      NodeFS.writeFileSync(NodePath.join(dir, CONFIG_FILES), text);
    },
  };
};

const replayer = () => {
  const replayed = replay(SCENARIO);
  const dirs = seed(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-mcp-")));
  const recorded = JSON.parse(
    NodeFS.readFileSync(NodePath.join(fixturesRoot(CLAUDE_KIND), SCENARIO, CONFIG_FILES), "utf8"),
  ) as ReadonlyArray<ConfigFiles>;
  const inner = runClaude({
    binary: () => ({ command: replayed.binaryPath, display: replayed.binaryPath }),
    env: () => childEnv(process.env, { configDir: dirs.configDir }),
  });
  let launches = 0;
  const run: RunClaude = (args, cwd) =>
    Effect.tap(inner(args, cwd), () =>
      Effect.sync(() => {
        const files = recorded[launches];
        launches += 1;
        expect(files?.argv, `launch ${launches}`).toEqual(args);
        NodeFS.writeFileSync(
          NodePath.join(dirs.configDir, ".claude.json"),
          `${JSON.stringify({ mcpServers: files!.user }, null, 2)}\n`,
        );
        const mcpJson = NodePath.join(dirs.workspace, ".mcp.json");
        if (files!.project === null) NodeFS.rmSync(mcpJson, { force: true });
        else NodeFS.writeFileSync(mcpJson, `${JSON.stringify(files!.project, null, 2)}\n`);
      }),
    );
  return {
    ...dirs,
    run,
    finish: () => {
      replayed.assertPlayedOut();
      expect(launches).toBe(recorded.length);
    },
  };
};

const driver = RECORD ? recorder() : replayer();
afterAll(() => {
  driver.finish();
});

const mcp = makeClaudeMcpServers({
  env: childEnv(process.env, { configDir: driver.configDir }),
  run: driver.run,
  writeMutex: Semaphore.makeUnsafe(1),
});

const user = { workspaceRoot: null };
const project = { workspaceRoot: driver.workspace };
const names = (servers: ReadonlyArray<McpServerConfig>) =>
  servers.map((server) => `${server.scope}:${server.name}`);

const WEB: McpServerConfig = {
  name: "web",
  scope: "user",
  enabled: true,
  transport: "http",
  url: "http://127.0.0.1:9/web",
  headers: { Authorization: "Bearer ${POSEIDON_TEST_TOKEN}" },
};
const LOCAL: McpServerConfig = {
  name: "local",
  scope: "user",
  enabled: true,
  transport: "stdio",
  command: "true",
  args: ["--flag", "two words"],
  env: { MODE: "test" },
};
const PROJ: McpServerConfig = {
  name: "proj",
  scope: "project",
  enabled: true,
  transport: "stdio",
  command: "true",
};

describe("the Claude Code MCP servers extension, recorded", () => {
  it.effect("lists, adds, edits, refuses and removes through the CLI", () =>
    Effect.gen(function* () {
      // The hand-made servers, read from the two files: not ours.
      expect(yield* mcp.list(project)).toEqual([
        {
          name: "hand-made",
          scope: "user",
          enabled: true,
          managed: false,
          transport: "http",
          url: "http://127.0.0.1:9/hand",
          headers: { "X-Team": "${TEAM_TOKEN}" },
        },
        {
          name: "hand-project",
          scope: "project",
          enabled: true,
          managed: false,
          transport: "stdio",
          command: "true",
        },
      ]);

      const afterWeb = yield* mcp.add(project, WEB);
      expect(afterWeb.find((server) => server.name === "web")).toEqual({ ...WEB, managed: true });

      const afterLocal = yield* mcp.add(user, LOCAL);
      expect(afterLocal.find((server) => server.name === "local")).toEqual({
        ...LOCAL,
        managed: true,
      });
      expect(names(afterLocal)).toEqual(["user:hand-made", "user:web", "user:local"]);

      const afterProj = yield* mcp.add(project, PROJ);
      expect(afterProj.find((server) => server.name === "proj")).toEqual({
        ...PROJ,
        managed: true,
      });
      expect(names(afterProj)).toEqual([
        "user:hand-made",
        "user:web",
        "user:local",
        "project:hand-project",
        "project:proj",
      ]);

      // An edit of one of ours: the CLI adds no name its scope holds, so it
      // is a remove and an add.
      const edited = { ...WEB, url: "http://127.0.0.1:9/web-two" };
      const afterEdit = yield* mcp.add(project, edited);
      expect(afterEdit.find((server) => server.name === "web")).toEqual({
        ...edited,
        managed: true,
      });

      // The user's own servers are never overwritten or removed.
      const overwrite = yield* Effect.flip(mcp.add(user, { ...WEB, name: "hand-made" }));
      expect(overwrite.code).toBe("conflict");
      const removeHandMade = yield* Effect.flip(mcp.remove(project, "project", "hand-project"));
      expect(removeHandMade.code).toBe("conflict");

      // What the CLI cannot express is refused before it runs.
      const disabled = yield* Effect.flip(mcp.add(user, { ...WEB, enabled: false }));
      expect(disabled.code).toBe("invalid");
      const ownName = yield* Effect.flip(mcp.add(user, { ...WEB, name: "poseidon" }));
      expect(ownName.code).toBe("invalid");

      // What the CLI itself refuses comes back in its own words.
      const badName = yield* Effect.flip(mcp.add(user, { ...WEB, name: "bad name" }));
      expect(badName.code).toBe("invalid");
      expect(badName.message).toContain("Invalid name bad name");

      const afterRemove = yield* mcp.remove(user, "user", "web");
      expect(names(afterRemove)).toEqual(["user:hand-made", "user:local"]);

      const missing = yield* Effect.flip(mcp.remove(user, "user", "web"));
      expect(missing.code).toBe("not-found");

      const afterProjRemove = yield* mcp.remove(project, "project", "proj");
      expect(names(afterProjRemove)).toEqual([
        "user:hand-made",
        "user:local",
        "project:hand-project",
      ]);

      // The ledger names what is left of ours by the entry the CLI stored.
      const claudeJson = NodePath.join(driver.configDir, ".claude.json");
      const stored = (readJson(claudeJson) as { mcpServers: Record<string, unknown> }).mcpServers;
      const ledger = JSON.parse(
        NodeFS.readFileSync(NodePath.join(driver.configDir, LEDGER_FILE), "utf8"),
      ) as unknown;
      expect(ledger).toEqual({ files: { [claudeJson]: { local: fingerprint(stored.local) } } });

      // A .mcp.json with keys besides mcpServers, which the CLI drops when it
      // rewrites the file, is refused before the CLI runs.
      const mcpJson = NodePath.join(driver.workspace, ".mcp.json");
      NodeFS.writeFileSync(
        mcpJson,
        `${JSON.stringify({ $schema: "https://example.invalid/mcp.json", ...(readJson(mcpJson) as object) }, null, 2)}\n`,
      );
      const dropsKeys = yield* Effect.flip(mcp.add(project, { ...PROJ, name: "schema" }));
      expect(dropsKeys.code).toBe("conflict");
      expect(dropsKeys.message).toContain('"$schema"');
    }),
  );
});
