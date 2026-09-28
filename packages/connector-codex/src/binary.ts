/**
 * Which executable "codex" means, and how to spell a call to it.
 *
 * Resolution order: the configured `binaryPath`, then `codex` on `PATH`, then
 * the directories the CLI's installers put it in, which a GUI process launched
 * from Finder never inherits — launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.
 * There is no fallback beyond that: a machine without the CLI gets a probe that
 * says "not installed", never a runner that downloads one.
 *
 * The probe and the session both resolve through here, so the binary the
 * connectors page reports is the binary a turn runs.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface ResolvedBinary {
  /** The absolute path spawned — or the configured path, as given. */
  readonly command: string;
  /** What the probe reports as `binaryPath`. */
  readonly display: string;
}

/** A regular file with the exec bit. */
const isExecutable = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The directories the CLI's installers use: Homebrew on both architectures,
 * `~/.local/bin`, and the global bin directories of npm, pnpm and bun.
 */
export const extraBinDirs = (): Array<string> => {
  const home = NodeOS.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    NodePath.join(home, ".local", "bin"),
    NodePath.join(home, ".npm-global", "bin"),
    NodePath.join(home, ".local", "share", "pnpm"),
    NodePath.join(home, "Library", "pnpm"),
    NodePath.join(home, ".bun", "bin"),
  ];
};

/**
 * The binary a probe or a session should run, or `null` when nothing named
 * `codex` is found. A configured path is taken as given: the user named it,
 * and the probe's `--version` is what finds out whether it runs.
 */
export const resolveBinary = (
  config: { readonly binaryPath?: string | undefined },
  env: Readonly<Record<string, string | undefined>>,
  /** The directories searched after PATH; a test narrows it to nothing. */
  extraDirs: ReadonlyArray<string> = extraBinDirs(),
): ResolvedBinary | null => {
  if (config.binaryPath !== undefined && config.binaryPath !== "") {
    return { command: config.binaryPath, display: config.binaryPath };
  }
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...extraDirs];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, "codex");
    if (isExecutable(candidate)) {
      return { command: candidate, display: candidate };
    }
  }
  return null;
};

/** POSIX single-quoting, only when the word needs it. */
const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The line a user types in their own terminal to run `args` against this
 * resolution — how a probe hands the UI a fixing command. It names the binary
 * that was found by its full path, which works from any shell, and prefixes
 * `CODEX_HOME=…` when the instance signs in to an account of its own, so the
 * login lands where the sessions will look for it.
 */
export const terminalCommand = (
  binary: ResolvedBinary,
  args: ReadonlyArray<string>,
  codexHome?: string,
): string =>
  [
    ...(codexHome === undefined ? [] : [`CODEX_HOME=${shellWord(codexHome)}`]),
    ...[binary.command, ...args].map(shellWord),
  ].join(" ");
