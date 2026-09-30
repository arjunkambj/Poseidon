/**
 * The MCP servers extension against the real CLI's recorded answers.
 *
 * `fixtures/codex/mcp-servers/` is this very script run through the testkit's
 * stdio tee against the operator's `codex`, on a scratch `CODEX_HOME` seeded
 * with one server written by hand (`HAND_MADE_TOML`): every `codex mcp list
 * --json`, `add` and `remove` the extension ran, with what the CLI printed and
 * how it exited. The replay hands each launch the next recorded one with the
 * same argv, so a change in what the extension runs, or in what order, fails
 * here.
 *
 *     POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
 *       pnpm -F @poseidon/connector-codex exec vitest run src/extensions/mcpServersRecorded.test.ts
 *
 * records it again. No thread starts and no account is read, so it costs
 * nothing.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { McpServerConfig } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { afterAll } from "vitest";

import { finalise, RECORD, realCodex, teeInFront } from "../../test/record";
import { replay } from "../../test/replay";
import { childEnv } from "../env";
import { parseVersion } from "../probe";
import { LEDGER_FILE, makeCodexMcpServers } from "./mcpServers";

const SCENARIO = "mcp-servers";

/** The server the user configured themselves, before Poseidon touched anything. */
const HAND_MADE_TOML = `[mcp_servers.hand-made]
url = "http://127.0.0.1:9/hand"
enabled = false
env_http_headers = { "X-Team" = "TEAM_TOKEN" }

[mcp_servers.hand-made.http_headers]
"X-Client" = "poseidon-test"
`;

const recorder = () => {
  const codex = realCodex();
  const cliVersion = parseVersion(execFileSync(codex, ["--version"], { encoding: "utf8" }));
  const { rawDir, launcher } = teeInFront(codex, SCENARIO);
  const codexHome = "/tmp/poseidon-codex/mcp-home";
  NodeFS.rmSync(codexHome, { recursive: true, force: true });
  NodeFS.mkdirSync(codexHome, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(codexHome, "config.toml"), HAND_MADE_TOML);
  return {
    binaryPath: launcher,
    codexHome,
    finish: () =>
      finalise({
        codex,
        scenario: SCENARIO,
        rawDir,
        description:
          "The MCP servers extension on a scratch CODEX_HOME holding one hand-written server: codex mcp list --json, add (http with a bearer variable, stdio with env), the refusals that run no add or remove, a name the CLI rejects, and a remove.",
        cliVersion: cliVersion ?? "unknown",
        model: "default",
        prompts: [],
      }),
  };
};

const replayer = () => {
  const replayed = replay(SCENARIO);
  return {
    binaryPath: replayed.binaryPath,
    codexHome: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-mcp-home-")),
    finish: () => replayed.assertPlayedOut(),
  };
};

const driver = RECORD ? recorder() : replayer();
afterAll(() => {
  driver.finish();
});

const mcp = makeCodexMcpServers({
  binary: () => ({ command: driver.binaryPath, display: driver.binaryPath }),
  env: () => childEnv(process.env, { codexHome: driver.codexHome }),
  codexHome: driver.codexHome,
  writeMutex: Semaphore.makeUnsafe(1),
});

const user = { workspaceRoot: null };
const names = (servers: ReadonlyArray<McpServerConfig>) => servers.map((server) => server.name);

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
  command: "node",
  args: ["server.js", "--flag"],
  env: { MODE: "test" },
};

describe("the Codex MCP servers extension, recorded", () => {
  it.effect("lists, adds, refuses and removes through the CLI", () =>
    Effect.gen(function* () {
      // The hand-made server, read back as the CLI reports it: disabled, its
      // literal and variable headers merged, and not ours.
      expect(yield* mcp.list(user)).toEqual([
        {
          name: "hand-made",
          scope: "user",
          enabled: false,
          managed: false,
          transport: "http",
          url: "http://127.0.0.1:9/hand",
          headers: { "X-Client": "poseidon-test", "X-Team": "${TEAM_TOKEN}" },
        },
      ]);

      const afterWeb = yield* mcp.add(user, WEB);
      expect(afterWeb.find((server) => server.name === "web")).toEqual({ ...WEB, managed: true });

      const afterLocal = yield* mcp.add(user, LOCAL);
      expect(afterLocal.find((server) => server.name === "local")).toEqual({
        ...LOCAL,
        managed: true,
      });
      expect(names(afterLocal).toSorted()).toEqual(["hand-made", "local", "web"]);

      // The user's own server is never overwritten or removed.
      const overwrite = yield* Effect.flip(mcp.add(user, { ...WEB, name: "hand-made" }));
      expect(overwrite.code).toBe("conflict");
      const removeHandMade = yield* Effect.flip(mcp.remove(user, "user", "hand-made"));
      expect(removeHandMade.code).toBe("conflict");

      // What the CLI itself refuses comes back in its own words.
      const badName = yield* Effect.flip(mcp.add(user, { ...WEB, name: "bad name" }));
      expect(badName.code).toBe("invalid");
      expect(badName.message).toContain("invalid server name");

      const afterRemove = yield* mcp.remove(user, "user", "web");
      expect(names(afterRemove).toSorted()).toEqual(["hand-made", "local"]);

      const missing = yield* Effect.flip(mcp.remove(user, "user", "web"));
      expect(missing.code).toBe("not-found");

      const ledger = JSON.parse(
        NodeFS.readFileSync(NodePath.join(driver.codexHome, LEDGER_FILE), "utf8"),
      ) as unknown;
      expect(ledger).toEqual({ servers: ["local"] });
    }),
  );
});
