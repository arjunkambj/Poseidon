/**
 * What the recorders share: the operator's real `codex` behind the testkit's
 * stdio tee, and the finaliser that scrubs what the tee captured into
 * `fixtures/codex/<scenario>/`.
 *
 * Recordings run the operator's own CLI under their own `CODEX_HOME` — the
 * login lives there — with `POSEIDON_HOME=/tmp/poseidon-codex` and session
 * scenarios in throwaway git repos under that root. That root is what the
 * finaliser scrubs to `<SCRATCH>`.
 *
 * The operator's own configuration shows up in a capture: the MCP servers of
 * their `config.toml` start inside a session and announce themselves, and
 * their skills are listed by name. Both are named to the finaliser, read from
 * `codex mcp list --json` and `$CODEX_HOME/skills`, so each becomes a
 * `user-skill-<n>` stand-in.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeTeeLauncher } from "@poseidon/testkit/sdkStreamRecording";
import { finalizeStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";

import { resolveBinary } from "../src/binary";
import { CODEX_KIND } from "../src/kind";

/** Recorders run only when asked: they spend the operator's own account. */
export const RECORD = process.env.POSEIDON_RECORD_CODEX === "1";

/** The operator's `CODEX_HOME`, where their login, config and skills live. */
const operatorCodexHome = (): string =>
  process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");

/** The operator's real `codex`, by absolute path. */
export const realCodex = (): string => {
  const real = resolveBinary({}, process.env);
  if (real === null) throw new Error("no codex binary to record");
  return real.command;
};

/**
 * The names of the operator's own MCP servers and skills, for the finaliser
 * to replace wherever they stand alone.
 */
const operatorNames = (codex: string): ReadonlyArray<string> => {
  const servers = JSON.parse(
    execFileSync(codex, ["mcp", "list", "--json"], { encoding: "utf8" }),
  ) as ReadonlyArray<{ readonly name?: unknown }>;
  let skills: ReadonlyArray<string> = [];
  try {
    skills = NodeFS.readdirSync(NodePath.join(operatorCodexHome(), "skills"));
  } catch {
    // No skills of their own.
  }
  return [
    ...servers.flatMap((server) => (typeof server.name === "string" ? [server.name] : [])),
    ...skills.filter((name) => !name.startsWith(".")),
  ];
};

/** A tee in front of the real CLI, writing into a fresh raw directory. */
export const teeInFront = (codex: string, scenario: string) => {
  const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `codex-${scenario}-raw-`));
  return { rawDir, launcher: makeTeeLauncher({ realBinary: codex, rawDir }) };
};

/** Writes `fixtures/codex/<scenario>/` from what the tee captured; returns its path. */
export const finalise = (options: {
  readonly codex: string;
  readonly scenario: string;
  readonly rawDir: string;
  readonly description: string;
  readonly cliVersion: string;
  readonly model: string;
  readonly prompts: ReadonlyArray<string>;
}): string =>
  finalizeStdioJsonRpcRecording({
    kind: CODEX_KIND,
    scenario: options.scenario,
    rawDir: options.rawDir,
    description: options.description,
    cliVersion: options.cliVersion,
    model: options.model,
    prompts: options.prompts,
    configDir: operatorCodexHome(),
    operatorNames: operatorNames(options.codex),
  });
