/**
 * How a session's app-server is launched, and what its recorded launches
 * show: Poseidon's MCP server named by URL, and its bearer nowhere in argv.
 */

import { recordingNames } from "@poseidon/testkit/recording";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import { describe, expect, it } from "vitest";

import { UNREACHABLE_MCP } from "../test/services";
import { CODEX_KIND } from "./kind";
import { MCP_BEARER_ENV, sessionEnv, sessionServerArgs } from "./launch";

describe("sessionServerArgs and sessionEnv", () => {
  it("names the MCP server's URL and bearer variable in argv, and the bearer only in the env", () => {
    const args = sessionServerArgs(UNREACHABLE_MCP);
    expect(args).toEqual([
      "app-server",
      "-c",
      `mcp_servers.poseidon.url="${UNREACHABLE_MCP.url}"`,
      "-c",
      `mcp_servers.poseidon.bearer_token_env_var="${MCP_BEARER_ENV}"`,
    ]);
    expect(args.join(" ")).not.toContain(UNREACHABLE_MCP.bearer);
    expect(sessionEnv({ PATH: "/bin" }, UNREACHABLE_MCP)).toEqual({
      PATH: "/bin",
      [MCP_BEARER_ENV]: UNREACHABLE_MCP.bearer,
    });
  });

  it("launched every recorded session that way", () => {
    for (const scenario of recordingNames(CODEX_KIND)) {
      // `mcp-servers` records the one-shot `codex mcp` commands, no session.
      for (const invocation of loadStdioJsonRpcRecording(
        CODEX_KIND,
        scenario,
      ).manifest.invocations.filter((launch) => launch.argv.includes("app-server"))) {
        expect(invocation.argv, scenario).toEqual(sessionServerArgs(UNREACHABLE_MCP));
      }
    }
  });
});
