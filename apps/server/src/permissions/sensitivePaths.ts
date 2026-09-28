/**
 * Paths a permission decision always asks about.
 *
 * The list is deliberately about *credentials and secrets*, not about being
 * cautious in general — `.env` files, key material, SSH and cloud credentials,
 * password stores. "full-access" allows everything *except* these, so the
 * check sits below the runtime-mode shortcut in the ladder.
 *
 * The directory rules look only at the part of a path a tool call reaches
 * into. Where the user keeps a project is their choice, not the tool's: a
 * workspace under `.claude/worktrees/` is ordinary source, and every absolute
 * path inside it names that `.claude` segment. So for an absolute path inside
 * the thread's workspace root, only the root's own name and what lies below it
 * are checked — `~/.claude` opened as a project still counts, and so does the
 * project's own `.claude/settings.json`.
 */

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".netrc",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];

/**
 * Directories whose whole contents count. The harness config homes are here
 * because they hold auth tokens and the harness's own permission settings — a
 * tool call rewriting them could grant itself more than the user did.
 * `.agent-browser` holds the browser CLI's auth vault and its config, whose
 * `executablePath` and `plugins` name programs to run.
 */
const SENSITIVE_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".git",
  ".commandcode",
  ".claude",
  ".codex",
  ".agent-browser",
]);

/** `.config/<name>` homes, matched as two consecutive segments. */
const SENSITIVE_CONFIG_HOMES = new Set([".config/gh", ".config/opencode"]);

const normalize = (path: string): string =>
  path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");

const segmentsOf = (path: string): ReadonlyArray<string> =>
  normalize(path)
    .split("/")
    .filter((segment) => segment.length > 0);

const isAbsolute = (path: string): boolean => /^(?:[\\/]|[a-z]:[\\/])/i.test(path);

/**
 * How many leading segments of `lowered` sit above the workspace root: all of
 * the root's but its last, when `path` is absolute and inside the root. A `..`
 * could climb back out, so a path holding one is checked whole.
 */
const segmentsAboveRoot = (
  path: string,
  lowered: ReadonlyArray<string>,
  workspaceRoot: string | undefined,
): number => {
  if (
    workspaceRoot === undefined ||
    !isAbsolute(path) ||
    !isAbsolute(workspaceRoot) ||
    lowered.includes("..")
  ) {
    return 0;
  }
  const root = segmentsOf(workspaceRoot).map((segment) => segment.toLowerCase());
  const inside =
    root.length > 0 &&
    root.length <= lowered.length &&
    root.every((segment, index) => lowered[index] === segment);
  return inside ? root.length - 1 : 0;
};

export const isSensitivePath = (path: string, workspaceRoot?: string): boolean => {
  const segments = segmentsOf(path);
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  if (basename === "" || basename === "." || basename === "..") {
    return false;
  }
  // `.env*` — the prefix match also covers `.envrc`,
  // which the exact/extension forms miss.
  if (SENSITIVE_BASENAMES.has(basename) || basename.startsWith(".env")) {
    return true;
  }
  if (SENSITIVE_EXTENSIONS.some((extension) => basename.endsWith(extension))) {
    return true;
  }
  const all = segments.map((segment) => segment.toLowerCase());
  const lowered = all.slice(segmentsAboveRoot(path, all, workspaceRoot));
  if (lowered.some((segment) => SENSITIVE_SEGMENTS.has(segment))) {
    return true;
  }
  // `.config/gh` and `.config/opencode` are two-segment matches — gh's
  // hosts.yml holds tokens, the other is a harness config home.
  return lowered.some((segment, index) =>
    SENSITIVE_CONFIG_HOMES.has(`${segment}/${lowered[index + 1] ?? ""}`),
  );
};

/**
 * Whether a command line names a sensitive path anywhere in its arguments.
 *
 * `cat ~/.ssh/id_rsa` and `cp .env /tmp` read secrets just as surely as a
 * `file_read` request does, and a sensitive path always prompts — so the
 * check cannot be limited to file-kind requests. Splitting on
 * shell separators and quotes is deliberately rough: this decides whether to
 * *ask*, and asking about one argument too many costs a keystroke.
 */
export const commandTouchesSensitivePath = (command: string, workspaceRoot?: string): boolean =>
  command
    .split(/[\s;|&<>()`]+/)
    .map((token) => token.replace(/^["']+/, "").replace(/["']+$/, ""))
    .some((token) => token.length > 0 && isSensitivePath(token, workspaceRoot));
