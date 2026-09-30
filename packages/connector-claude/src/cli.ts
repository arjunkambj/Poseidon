/**
 * Running the Claude Code CLI for an extension: one short command — `claude
 * mcp add-json …`, `claude mcp remove …` — with the connector's default-deny
 * environment and the instance's `CLAUDE_CONFIG_DIR` (`env.ts`), in the
 * directory the caller names.
 */

import { execFile } from "node:child_process";
import { ConnectorExtensionFailed } from "@poseidon/connector-sdk/extensions";
import * as Effect from "effect/Effect";

import type { ResolvedBinary } from "./binary";

/** What one run printed, and how it exited. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Which CLI an extension runs, and with what environment. */
export interface ClaudeCli {
  /** The binary to run, resolved per call: an install that appears later is found. */
  readonly binary: () => ResolvedBinary | null;
  /** The child's environment: default deny, with the instance's `CLAUDE_CONFIG_DIR`. */
  readonly env: () => Record<string, string>;
}

/** Runs `claude <args>` in `cwd`; a CLI that cannot be started at all fails `internal`. */
export type RunClaude = (
  args: ReadonlyArray<string>,
  cwd: string,
) => Effect.Effect<Ran, ConnectorExtensionFailed>;

const internal = (message: string) => new ConnectorExtensionFailed({ code: "internal", message });

/**
 * What the CLI said went wrong: its stderr, else its stdout, trimmed. It
 * prints its refusals on stderr, one line each.
 */
export const cliError = (ran: Ran): string => {
  const said = ran.stderr.trim() === "" ? ran.stdout.trim() : ran.stderr.trim();
  return said === "" ? "claude exited without saying why" : said;
};

export const runClaude =
  (cli: ClaudeCli): RunClaude =>
  (args, cwd) =>
    Effect.gen(function* () {
      const binary = cli.binary();
      if (binary === null) {
        return yield* internal("claude not found on PATH or in the usual install directories");
      }
      const env = cli.env();
      return yield* Effect.callback<Ran, ConnectorExtensionFailed>((resume) => {
        const child = execFile(
          binary.command,
          [...args],
          { cwd, timeout: 30_000, encoding: "utf8", env },
          (error, stdout, stderr) => {
            if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
              resume(Effect.fail(internal(`${binary.display}: ${error.message}`)));
              return;
            }
            resume(
              Effect.succeed({
                code: error === null ? 0 : (error as { code: number }).code,
                stdout,
                stderr,
              }),
            );
          },
        );
        return Effect.sync(() => child.kill());
      });
    });
