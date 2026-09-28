/**
 * The pure half of `scripts.detect`: which directories a workspace declares
 * as its packages, which package manager it uses, and the ready-to-run
 * command for each package.json script. Nothing here touches the disk; the
 * service (`./ScriptDetection.ts`) reads the files and lists directories
 * through the callback `expandPatterns` takes.
 *
 * pnpm-workspace.yaml is read by a small line parser for its `packages:` list
 * rather than a YAML library: that list is all detection needs, and it is
 * written the same simple way in practice — block items or one flow list.
 */
import type { DetectedScript, PackageManager } from "@poseidon/contracts/scripts";

/** The most packages, root included, whose scripts are listed. */
export const MAX_PACKAGES = 64;
/** The most scripts listed across every package. */
export const MAX_SCRIPTS = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` without one pair of surrounding quotes, single or double. */
const unquote = (value: string): string => {
  const trimmed = value.trim();
  const first = trimmed[0];
  return trimmed.length >= 2 && (first === "'" || first === '"') && trimmed.endsWith(first)
    ? trimmed.slice(1, -1)
    : trimmed;
};

/** A line without its trailing `# comment`, leaving a `#` inside quotes alone. */
const stripComment = (line: string): string => {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
};

/** The `packages:` list of a pnpm-workspace.yaml, block or flow style. */
const pnpmPackages = (yaml: string): Array<string> => {
  const found: Array<string> = [];
  let inList = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = stripComment(raw).trimEnd();
    if (line.trim().length === 0) continue;
    const indented = /^\s/.test(line);
    if (!indented) {
      const key = /^packages\s*:\s*(.*)$/.exec(line);
      inList = key !== null;
      const rest = key?.[1]?.trim() ?? "";
      if (rest.startsWith("[") && rest.endsWith("]")) {
        found.push(...rest.slice(1, -1).split(",").map(unquote));
        inList = false;
      }
      continue;
    }
    if (!inList) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item !== null) found.push(unquote(item[1] ?? ""));
  }
  return found.filter((pattern) => pattern.length > 0);
};

/** package.json `workspaces`: a list, or `{ packages: [...] }` as yarn writes it. */
const packageJsonWorkspaces = (rootPackageJson: unknown): Array<string> => {
  if (!isRecord(rootPackageJson)) return [];
  const workspaces = rootPackageJson["workspaces"];
  const list = isRecord(workspaces) ? workspaces["packages"] : workspaces;
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
};

/**
 * The workspace package patterns a root declares: pnpm-workspace.yaml's
 * `packages:` list first, then package.json `workspaces`, each once.
 */
export const workspacePatterns = (
  pnpmWorkspaceYaml: string | null,
  rootPackageJson: unknown,
): ReadonlyArray<string> => [
  ...new Set([
    ...(pnpmWorkspaceYaml === null ? [] : pnpmPackages(pnpmWorkspaceYaml)),
    ...packageJsonWorkspaces(rootPackageJson),
  ]),
];

/** A pattern as clean relative segments: no `./`, no empty or `.` segments. */
const segmentsOf = (pattern: string): Array<string> =>
  pattern
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");

const escapeRegex = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** One path segment's glob as a regex: `*` is any run of characters. */
const segmentRegex = (segment: string) =>
  new RegExp(`^${segment.split("*").map(escapeRegex).join(".*")}$`);

/** A whole negation pattern as a regex over a relative dir; `**` spans segments. */
const negationRegex = (segments: ReadonlyArray<string>) =>
  new RegExp(
    `^${segments
      .map((segment) =>
        segment === "**" ? ".*" : segment.split("*").map(escapeRegex).join("[^/]*"),
      )
      .join("/")}$`,
  );

const skipped = (name: string) => name === "node_modules" || name.startsWith(".");

/**
 * The relative directories `patterns` name, sorted and each once. A literal
 * segment is taken as written — the caller finds out whether a package.json
 * is there — while `*` and `**` list the directory (`**` one level deep, which
 * is how monorepos use it). A `!` pattern removes what it matches; a pattern
 * that climbs out with `..`, `node_modules` and dot directories are skipped.
 */
export const expandPatterns = async (
  patterns: ReadonlyArray<string>,
  listDir: (dir: string) => Promise<ReadonlyArray<string>>,
): Promise<ReadonlyArray<string>> => {
  const include: Array<Array<string>> = [];
  const exclude: Array<RegExp> = [];
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const segments = segmentsOf(negated ? pattern.slice(1) : pattern);
    if (segments.length === 0 || segments.includes("..")) continue;
    if (negated) exclude.push(negationRegex(segments));
    else include.push(segments);
  }

  const found = new Set<string>();
  for (const segments of include) {
    let dirs: Array<string> = [""];
    for (const segment of segments) {
      const next: Array<string> = [];
      for (const dir of dirs) {
        if (!segment.includes("*")) {
          if (segment !== "node_modules") next.push(dir === "" ? segment : `${dir}/${segment}`);
          continue;
        }
        const matcher = segmentRegex(segment === "**" ? "*" : segment);
        for (const name of await listDir(dir)) {
          if (!skipped(name) && matcher.test(name)) next.push(dir === "" ? name : `${dir}/${name}`);
        }
      }
      dirs = next;
    }
    for (const dir of dirs) found.add(dir);
  }
  return [...found]
    .filter((dir) => dir.length > 0 && !exclude.some((regex) => regex.test(dir)))
    .sort();
};

const MANAGERS: ReadonlyArray<PackageManager> = ["npm", "pnpm", "yarn", "bun"];

/**
 * The workspace's package manager: package.json's `packageManager` field
 * (`pnpm@10.1.0`) when it names one, else the lockfile present — pnpm, yarn,
 * then bun — else npm.
 */
export const packageManagerOf = (
  packageManagerField: unknown,
  lockfiles: ReadonlySet<string>,
): PackageManager => {
  if (typeof packageManagerField === "string") {
    const name = packageManagerField.split("@")[0]?.trim();
    const named = MANAGERS.find((manager) => manager === name);
    if (named !== undefined) return named;
  }
  if (lockfiles.has("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.has("yarn.lock")) return "yarn";
  if (lockfiles.has("bun.lock") || lockfiles.has("bun.lockb")) return "bun";
  return "npm";
};

/** The lockfile names `packageManagerOf` looks for. */
export const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const;

/** A POSIX shell word: single-quoted, with each `'` closed, escaped and reopened. */
const posixQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** A word the shell reads as itself, with no quoting needed. */
const plainWord = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * The command that runs script `name` of the package at `dir` from the
 * workspace root: `pnpm run dev` for the root, `cd 'apps/web' && pnpm run dev`
 * for a nested package. The name is quoted only when the shell would read it
 * otherwise. POSIX shells only; on Windows it is best effort.
 */
export const scriptRunCommand = (pm: PackageManager, dir: string, name: string): string => {
  const run = `${pm} run ${plainWord.test(name) ? name : posixQuote(name)}`;
  return dir === "" ? run : `cd ${posixQuote(dir)} && ${run}`;
};

/** One package.json read off the disk: its dir relative to the root ("" for the root). */
export interface FoundPackage {
  readonly dir: string;
  readonly packageJson: unknown;
}

/** The root ("") first, then the rest by directory. */
const byDir = (a: FoundPackage, b: FoundPackage): number =>
  a.dir === b.dir ? 0 : a.dir === "" ? -1 : b.dir === "" ? 1 : a.dir < b.dir ? -1 : 1;

/**
 * Every script of `packages`, root first and then by directory, up to
 * `MAX_PACKAGES` packages and `MAX_SCRIPTS` scripts. A package.json that is
 * not an object is skipped, as is a script whose body is not a non-empty
 * string.
 */
export const detectedScripts = (
  packageManager: PackageManager,
  packages: ReadonlyArray<FoundPackage>,
): ReadonlyArray<DetectedScript> => {
  const ordered = packages
    .filter((found) => isRecord(found.packageJson))
    .sort(byDir)
    .slice(0, MAX_PACKAGES);
  const scripts: Array<DetectedScript> = [];
  for (const found of ordered) {
    const packageJson = found.packageJson as Record<string, unknown>;
    const entries = isRecord(packageJson["scripts"]) ? Object.entries(packageJson["scripts"]) : [];
    const name = packageJson["name"];
    for (const [script, body] of entries) {
      if (script.length === 0 || typeof body !== "string" || body.trim().length === 0) continue;
      if (scripts.length >= MAX_SCRIPTS) return scripts;
      scripts.push({
        id: `pkg:${found.dir}:${script}`,
        name: script,
        packageName: typeof name === "string" && name.length > 0 ? name : null,
        packageDir: found.dir,
        command: scriptRunCommand(packageManager, found.dir, script),
        packageManager,
      });
    }
  }
  return scripts;
};
