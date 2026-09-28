/**
 * Which shell a terminal runs and the environment it starts with. Pure: the
 * platform and the base environment come in as arguments, so every branch is
 * testable on any host.
 */
import { existsSync } from "node:fs";
import * as nodePath from "node:path";

export interface ShellCommand {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Shells that take `-l`. A login shell reads the user's profile, which is what
 * gives an app launched from the Finder or a desktop menu — whose own env is
 * the bare launchd/session one — the PATH the user sees in their own terminal.
 */
const LOGIN_SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh"]);

/**
 * The user's shell: `$SHELL` when it is an absolute path, else the platform's
 * usual one. `isFile` is the only thing read from the machine, and a test
 * passes its own.
 */
export const resolveShell = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean = existsSync,
): ShellCommand => {
  if (platform === "win32") {
    const comspec = env.COMSPEC ?? env.ComSpec;
    return { file: comspec !== undefined && comspec !== "" ? comspec : "powershell.exe", args: [] };
  }
  const file = pickPosixShell(platform, env.SHELL, isFile);
  return { file, args: LOGIN_SHELLS.has(nodePath.posix.basename(file)) ? ["-l"] : [] };
};

const pickPosixShell = (
  platform: NodeJS.Platform,
  shell: string | undefined,
  isFile: (path: string) => boolean,
): string => {
  if (shell !== undefined && shell !== "" && nodePath.posix.isAbsolute(shell)) return shell;
  if (platform === "darwin") return "/bin/zsh";
  return isFile("/bin/bash") ? "/bin/bash" : "/bin/sh";
};

/** Windows' Command Prompt, as `COMSPEC` names it. */
const COMMAND_PROMPT = /^cmd(\.exe)?$/i;
/** Windows PowerShell and PowerShell 7. */
const POWERSHELL = /^(powershell|pwsh)(\.exe)?$/i;

/**
 * The shell that runs one script as its own process and ends with it: the
 * terminal's shell handed the command to run instead of started interactive.
 * A POSIX shell keeps its own args, so a login shell stays one (`-l -c`) and
 * the script sees the PATH the user's profile sets. On Windows, `cmd.exe`
 * takes `/d /s /c` (no AutoRun, the rest of the line as the command) and
 * PowerShell `-Command`.
 */
export const scriptShellCommand = (
  shell: ShellCommand,
  command: string,
  platform: NodeJS.Platform,
): ShellCommand => {
  const name = (platform === "win32" ? nodePath.win32 : nodePath.posix).basename(shell.file);
  if (COMMAND_PROMPT.test(name)) return { file: shell.file, args: ["/d", "/s", "/c", command] };
  if (POWERSHELL.test(name)) return { file: shell.file, args: ["-NoLogo", "-Command", command] };
  return { file: shell.file, args: [...shell.args, "-c", command] };
};

/** Set by the AppImage runtime; meaningless, and misleading, to a program started from the terminal. */
const APPIMAGE_VARS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"];

/** Search-path variables the AppImage runtime prepends its mount point to. */
const APPIMAGE_PATH_VARS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "PYTHONPATH",
  "PERL5LIB",
  "QT_PLUGIN_PATH",
  "GSETTINGS_SCHEMA_DIR",
  "GST_PLUGIN_SYSTEM_PATH",
  "GST_PLUGIN_SYSTEM_PATH_1_0",
];

/**
 * The environment a terminal's shell starts with: the server's own, minus what
 * belongs to Poseidon itself.
 *
 * - `ELECTRON_RUN_AS_NODE` goes: the desktop app sets it to run this server
 *   under its Electron binary, and left in place it would turn every
 *   Electron-based CLI started from the terminal into plain Node.
 * - Every `POSEIDON_*` key goes. They configure this server, and a leaked
 *   `POSEIDON_HOME` would point a nested dev run at the real state.
 * - Under an AppImage, its runtime variables and the mount point's entries in
 *   the search paths go, so programs the user runs do not load the app's
 *   bundled libraries.
 * - `TERM`, `COLORTERM` and `TERM_PROGRAM` describe the client's emulator.
 * - On macOS an unset `LANG` becomes `en_US.UTF-8`: an app launched from the
 *   Finder has none, and zsh then mangles UTF-8 input.
 *
 * Keys compare case-insensitively on Windows, where the environment does.
 */
export const terminalEnv = (
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> => {
  const fold = (key: string) => (platform === "win32" ? key.toUpperCase() : key);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const folded = fold(key);
    if (folded === "ELECTRON_RUN_AS_NODE" || folded.startsWith("POSEIDON_")) continue;
    env[key] = value;
  }
  if (isAppImage(env)) scrubAppImage(env);
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Poseidon";
  if (platform === "darwin" && (env.LANG === undefined || env.LANG === "")) {
    env.LANG = "en_US.UTF-8";
  }
  return env;
};

const isAppImage = (env: Record<string, string>) =>
  (env.APPIMAGE ?? "") !== "" || (env.APPDIR ?? "") !== "";

const scrubAppImage = (env: Record<string, string>) => {
  const appDir = env.APPDIR;
  for (const key of APPIMAGE_VARS) delete env[key];
  if (appDir === undefined || appDir === "") return;
  const root = appDir.endsWith("/") ? appDir.slice(0, -1) : appDir;
  for (const key of APPIMAGE_PATH_VARS) {
    const value = env[key];
    if (value === undefined) continue;
    const kept = value
      .split(":")
      .filter((segment) => segment !== root && !segment.startsWith(`${root}/`));
    if (kept.length === 0) delete env[key];
    else env[key] = kept.join(":");
  }
};
