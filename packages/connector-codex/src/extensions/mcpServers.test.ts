/**
 * The pieces of the MCP servers extension that need no process: reading the
 * CLI's JSON listing (the rows `fixtures/codex/mcp-servers/` recorded), the
 * `codex mcp add` argv, and what the CLI's errors are reduced to. The
 * extension driven end to end is `mcpServersRecorded.test.ts`.
 */

import type { McpServerConfig } from "@poseidon/contracts/connectors";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import { describe, expect, it } from "vitest";

import { CODEX_KIND } from "../kind";
import { cliError } from "./cli";
import { addArgs, toMcpServerConfig } from "./mcpServers";

/** The last `codex mcp list --json` of the recording with the most servers, parsed. */
const recordedRows = (): ReadonlyArray<unknown> => {
  const lists = loadStdioJsonRpcRecording(CODEX_KIND, "mcp-servers").invocations.filter(
    (invocation) => invocation.argv.join(" ") === "mcp list --json",
  );
  const printed = lists.map((invocation) =>
    invocation.frames
      .filter((frame) => frame.dir === "from-harness" && frame.channel === "stdout")
      .map((frame) => (typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data)))
      .join("\n"),
  );
  const parsed = printed.map((text) => JSON.parse(text) as ReadonlyArray<unknown>);
  return parsed.reduce((most, rows) => (rows.length > most.length ? rows : most), []);
};

describe("toMcpServerConfig", () => {
  it("reads every row the CLI listed: stdio, http with a bearer variable, and a hand-made one", () => {
    const rows = recordedRows();
    expect(rows.length).toBe(3);
    const configs = rows.map((row) => toMcpServerConfig(row, false));
    expect(configs).toEqual([
      {
        name: "hand-made",
        scope: "user",
        enabled: false,
        managed: false,
        transport: "http",
        url: "http://127.0.0.1:9/hand",
        headers: { "X-Client": "poseidon-test", "X-Team": "${TEAM_TOKEN}" },
      },
      {
        name: "local",
        scope: "user",
        enabled: true,
        managed: false,
        transport: "stdio",
        command: "node",
        args: ["server.js", "--flag"],
        env: { MODE: "test" },
      },
      {
        name: "web",
        scope: "user",
        enabled: true,
        managed: false,
        transport: "http",
        url: "http://127.0.0.1:9/web",
        headers: { Authorization: "Bearer ${POSEIDON_TEST_TOKEN}" },
      },
    ]);
  });

  it("carries the ledger's verdict on ownership", () => {
    const [row] = recordedRows();
    expect(toMcpServerConfig(row, true)?.managed).toBe(true);
  });

  it("drops what it cannot show", () => {
    expect(toMcpServerConfig(null, false)).toBeNull();
    expect(toMcpServerConfig({ name: "x" }, false)).toBeNull();
    expect(toMcpServerConfig({ name: "x", transport: { type: "stdio" } }, false)).toBeNull();
    expect(
      toMcpServerConfig({ name: "x", transport: { type: "carrier-pigeon" } }, false),
    ).toBeNull();
  });
});

describe("addArgs", () => {
  const http: McpServerConfig = {
    name: "web",
    scope: "user",
    enabled: true,
    transport: "http",
    url: "http://127.0.0.1:9/web",
  };

  it("spells a stdio server with its env before the command, after --", () => {
    expect(
      addArgs({
        name: "local",
        scope: "user",
        enabled: true,
        transport: "stdio",
        command: "node",
        args: ["--inspect", "server.js"],
        env: { MODE: "test" },
      }),
    ).toEqual([
      "mcp",
      "add",
      "local",
      "--env",
      "MODE=test",
      "--",
      "node",
      "--inspect",
      "server.js",
    ]);
  });

  it("turns a bearer header naming a variable into the CLI's flag", () => {
    expect(addArgs({ ...http, headers: { authorization: "Bearer ${TOKEN}" } })).toEqual([
      "mcp",
      "add",
      "web",
      "--url",
      "http://127.0.0.1:9/web",
      "--bearer-token-env-var",
      "TOKEN",
    ]);
  });

  it("refuses, in words naming the fix, what the CLI cannot write", () => {
    expect(addArgs({ ...http, scope: "project" })).toContain(".codex/config.toml");
    expect(addArgs({ ...http, enabled: false })).toContain("enabled = false");
    expect(addArgs({ ...http, headers: { "X-Client": "a" } })).toContain("http_headers");
    // A literal token is never written where the CLI would keep it in plain text.
    expect(addArgs({ ...http, headers: { Authorization: "Bearer abc" } })).toBeTypeOf("string");
    expect(addArgs({ name: "s", scope: "user", enabled: true, transport: "stdio" })).toBeTypeOf(
      "string",
    );
  });
});

describe("cliError", () => {
  it("keeps the CLI's error without the warnings printed before it", () => {
    expect(
      cliError("WARNING: proceeding anyway\nError: failed to resolve CODEX_HOME\n\nCaused by: x\n"),
    ).toBe("Error: failed to resolve CODEX_HOME\n\nCaused by: x");
    expect(cliError("something odd\n")).toBe("something odd");
    expect(cliError("")).toBe("codex exited without saying why");
  });
});
