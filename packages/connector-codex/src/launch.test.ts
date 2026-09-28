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
      "-c",
      `shell_environment_policy.set.${MCP_BEARER_ENV}=""`,
    ]);
    expect(args.join(" ")).not.toContain(UNREACHABLE_MCP.bearer);
    expect(sessionEnv({ PATH: "/bin" }, UNREACHABLE_MCP)).toEqual({
      PATH: "/bin",
      [MCP_BEARER_ENV]: UNREACHABLE_MCP.bearer,
    });
  });

  it("blanks the bearer variable in the commands the model runs", () => {
    // The CLI's default policy passes variables named like secrets through
    // to commands; only this override keeps the bearer with the MCP client.
    expect(sessionServerArgs(UNREACHABLE_MCP)).toContain(
      `shell_environment_policy.set.${MCP_BEARER_ENV}=""`,
    );
  });

  it("launched every recorded session that way", () => {
    // `generate-text` is no session: its one-shot app-server names no MCP
    // server (`generateText.test.ts` checks its argv).
    for (const scenario of recordingNames(CODEX_KIND).filter((name) => name !== "generate-text")) {
      // `mcp-servers` records the one-shot `codex mcp` commands, no session.
      for (const invocation of loadStdioJsonRpcRecording(
        CODEX_KIND,
        scenario,
      ).manifest.invocations.filter((launch) => launch.argv.includes("app-server"))) {
        // Every recording points the server at the unreachable port but
        // `mcp-tool-approval`, which points it at a live loopback one.
        const url = /url="(http:\/\/127\.0\.0\.1:\d+\/mcp)"/.exec(invocation.argv.join(" "))?.[1];
        expect(url, scenario).toBeDefined();
        expect(invocation.argv, scenario).toEqual(
          sessionServerArgs({ url: url!, bearer: UNREACHABLE_MCP.bearer }),
        );
      }
    }
  });
});
