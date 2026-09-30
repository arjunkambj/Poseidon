/**
 * Running the Codex CLI for an extension: one short command — `codex mcp …`,
 * `codex plugin list` — with the connector's default-deny environment and the
 * instance's `CODEX_HOME` (`env.ts`), from a neutral directory, so no
 * project's `.codex/config.toml` is read.
 */

import { execFile } from "node:child_process";
import * as NodeOS from "node:os";
import { ConnectorExtensionFailed } from "@poseidon/connector-sdk/extensions";
import * as Effect from "effect/Effect";

import type { ResolvedBinary } from "../binary";

export const failed = (code: ConnectorExtensionFailed["code"], message: string) =>
  new ConnectorExtensionFailed({ code, message });

/** What one run printed, and how it exited. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Which CLI an extension runs, and with what environment. */
export interface CodexCli {
  /** The binary to run, resolved per call: an install that appears later is found. */
  readonly binary: () => ResolvedBinary | null;
  /** The child's environment: default deny, with the instance's `CODEX_HOME`. */
  readonly env: () => Record<string, string>;
}

/**
 * What the CLI said went wrong: from its `Error:` line on, without the
 * warnings it prints first; the whole of stderr when there is no such line.
 */
export const cliError = (stderr: string): string => {
  const at = stderr.indexOf("Error:");
  const said = (at < 0 ? stderr : stderr.slice(at)).trim();
  return said === "" ? "codex exited without saying why" : said;
};

/** Runs `codex <args>`; a CLI that cannot be started at all fails `internal`. */
export const runCodex =
  (cli: CodexCli) =>
  (args: ReadonlyArray<string>): Effect.Effect<Ran, ConnectorExtensionFailed> =>
    Effect.gen(function* () {
      const binary = cli.binary();
      if (binary === null) {
        return yield* failed(
          "internal",
          "codex not found on PATH or in the usual install directories",
        );
      }
      const env = cli.env();
      return yield* Effect.callback<Ran, ConnectorExtensionFailed>((resume) => {
        const child = execFile(
          binary.command,
          [...args],
          { cwd: NodeOS.tmpdir(), timeout: 30_000, encoding: "utf8", env },
          (error, stdout, stderr) => {
            if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
              resume(Effect.fail(failed("internal", `${binary.display}: ${error.message}`)));
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
