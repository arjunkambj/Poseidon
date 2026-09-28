/**
 * The sentence a fold reads as: "Ran 3 commands, edited 2 files, read 4
 * files" instead of "7 tools". A work group's label and a settled turn's fold
 * row both say what the work was, so a reader can tell a run of reads from a
 * run of edits without opening it.
 *
 * Each item is sorted into one kind of action by its item kind and, for a
 * tool call, by the words in its name and the keys of its input. Tool names
 * differ by harness, so this reads them generically — a word such as `read`,
 * `grep` or `list` in the name, or a `file_path`, `pattern` or `url` in the
 * input — and never names a harness. Whatever it cannot place is "used N
 * tools".
 *
 * Files count once per distinct path, whatever touched them: a file the run
 * created and then edited counts as created (`mergeKind`). Reads count per
 * path too. Everything else counts per item.
 *
 * The clauses come in a fixed order — commands, file changes, reads,
 * searches, listings, the web, the browser, other tools, tasks, skills — so
 * two groups doing the same work read the same. Past three clauses the rest
 * fold into "and N more", N being the actions they stand for. Reasoning is
 * not an action: a run of reasoning alone reads "Thought for 2s".
 */

import type { FileChangeKind, ItemSnapshot } from "@poseidon/contracts/runtime";

import { isBrowserTool } from "@/components/timeline/browser-tool";
import { toolPathTarget } from "@/components/timeline/tool-target";
import { formatDurationMs } from "@/lib/format";

export type ClauseKind =
  | "command"
  | "edit"
  | "create"
  | "delete"
  | "read"
  | "search"
  | "list"
  | "web-search"
  | "fetch"
  | "browser"
  | "mcp"
  | "task"
  | "skill"
  | "tool";

const ORDER: ReadonlyArray<ClauseKind> = [
  "command",
  "edit",
  "create",
  "delete",
  "read",
  "search",
  "list",
  "web-search",
  "fetch",
  "browser",
  "mcp",
  "task",
  "skill",
  "tool",
];

export interface WorkClause {
  readonly kind: ClauseKind;
  /** Distinct paths for file changes and reads; items for everything else. */
  readonly count: number;
}

/** How many clauses a sentence spells out before "and N more". */
const MAX_CLAUSES = 3;

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const PHRASE: Readonly<Record<ClauseKind, (count: number) => string>> = {
  command: (n) => `ran ${plural(n, "command", "commands")}`,
  edit: (n) => `edited ${plural(n, "file", "files")}`,
  create: (n) => `created ${plural(n, "file", "files")}`,
  delete: (n) => `deleted ${plural(n, "file", "files")}`,
  read: (n) => `read ${plural(n, "file", "files")}`,
  search: (n) => (n === 1 ? "searched once" : `searched ${n} times`),
  list: (n) => `listed ${plural(n, "folder", "folders")}`,
  "web-search": () => "searched the web",
  fetch: (n) => `fetched ${plural(n, "page", "pages")}`,
  browser: () => "used the browser",
  mcp: (n) => `called ${plural(n, "tool", "tools")}`,
  task: (n) => `ran ${plural(n, "task", "tasks")}`,
  skill: (n) => `used ${plural(n, "skill", "skills")}`,
  tool: (n) => `used ${plural(n, "tool", "tools")}`,
};

/**
 * A path touched twice keeps the kind that describes the net effect: a file
 * created and then edited is still new; anything else takes the latest kind.
 */
export const mergeKind = (earlier: FileChangeKind, later: FileChangeKind): FileChangeKind =>
  earlier === "create" && later === "edit" ? "create" : later;

const record = (input: unknown): Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

const hasString = (input: Readonly<Record<string, unknown>>, key: string): boolean =>
  typeof input[key] === "string" && (input[key] as string).trim() !== "";

/** `readFile`, `read_file`, `Read` → `["read", "file"]`. */
const words = (name: string): ReadonlySet<string> =>
  new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== ""),
  );

const any = (set: ReadonlySet<string>, ...candidates: ReadonlyArray<string>): boolean =>
  candidates.some((candidate) => set.has(candidate));

export interface WorkAction {
  readonly kind: ClauseKind;
  /** What makes two actions one: a path for files, the item otherwise. */
  readonly key: string;
}

/** A tool call by the words in its name, then by the keys of its input. */
const toolAction = (item: ItemSnapshot): WorkAction => {
  const name = words(item.tool?.name ?? "");
  const input = record(item.tool?.input);
  const path = toolPathTarget(input);
  const byItem = (kind: ClauseKind): WorkAction => ({ kind, key: item.itemId });
  const byPath = (kind: ClauseKind): WorkAction => ({ kind, key: path ?? item.itemId });

  if (any(name, "ls", "list", "dir", "directory", "readdir", "tree")) return byItem("list");
  if (any(name, "grep", "glob", "search", "find", "rg")) {
    return byItem(any(name, "web") ? "web-search" : "search");
  }
  if (any(name, "fetch") || (any(name, "web") && hasString(input, "url"))) return byItem("fetch");
  if (any(name, "read", "view", "cat")) return byPath("read");
  if (path !== undefined && any(name, "edit", "write", "patch", "replace")) return byPath("edit");
  if (any(name, "bash", "shell", "exec", "terminal") || hasString(input, "command")) {
    return byItem("command");
  }
  if (hasString(input, "pattern") || hasString(input, "query")) return byItem("search");
  if (path !== undefined) return byPath("read");
  if (hasString(input, "url")) return byItem("fetch");
  return byItem("tool");
};

/** The one action an item stands for, or `null` for what is not one (reasoning, messages). */
export const workAction = (item: ItemSnapshot): WorkAction | null => {
  switch (item.kind) {
    case "command_execution":
      return { kind: "command", key: item.itemId };
    case "file_change":
      return { kind: item.fileChange?.kind ?? "edit", key: item.fileChange?.path ?? item.itemId };
    case "web_search": {
      const input = record(item.tool?.input);
      const fetch = hasString(input, "url") && !hasString(input, "query");
      return { kind: fetch ? "fetch" : "web-search", key: item.itemId };
    }
    case "mcp_tool_call":
      return { kind: isBrowserTool(item.tool?.name ?? "") ? "browser" : "mcp", key: item.itemId };
    case "tool_call":
      return toolAction(item);
    case "task":
      return { kind: "task", key: item.itemId };
    case "skill":
      return { kind: "skill", key: item.itemId };
    default:
      return null;
  }
};

const FILE_KINDS: ReadonlySet<ClauseKind> = new Set(["edit", "create", "delete"]);

/** What `items` did, one clause per kind of action, in the fixed order. */
export const workClauses = (items: ReadonlyArray<ItemSnapshot>): ReadonlyArray<WorkClause> => {
  const files = new Map<string, FileChangeKind>();
  const others = new Map<ClauseKind, Set<string>>();
  for (const item of items) {
    const found = workAction(item);
    if (found === null) continue;
    if (FILE_KINDS.has(found.kind)) {
      const kind = found.kind as FileChangeKind;
      const seen = files.get(found.key);
      files.set(found.key, seen === undefined ? kind : mergeKind(seen, kind));
      continue;
    }
    const keys = others.get(found.kind) ?? new Set<string>();
    keys.add(found.key);
    others.set(found.kind, keys);
  }
  const counts = new Map<ClauseKind, number>();
  for (const kind of files.values()) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  for (const [kind, keys] of others) {
    counts.set(kind, keys.size);
  }
  return ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined ? [] : [{ kind, count }];
  });
};

/**
 * "Ran 3 commands, edited 2 files, read 4 files and 2 more", or `undefined`
 * when the items hold no action (reasoning or narration alone).
 */
export const workSentence = (
  items: ReadonlyArray<ItemSnapshot>,
  maxClauses: number = MAX_CLAUSES,
): string | undefined => {
  const clauses = workClauses(items);
  if (clauses.length === 0) {
    return undefined;
  }
  const shown = clauses.slice(0, maxClauses).map((clause) => PHRASE[clause.kind](clause.count));
  const rest = clauses.slice(maxClauses).reduce((sum, clause) => sum + clause.count, 0);
  const sentence = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

/** Items that failed, counted as the rows show them: top level only. */
export const countFailed = (items: ReadonlyArray<ItemSnapshot>): number =>
  items.filter((item) => item.status === "failed").length;

/** " · 1 failed" on the end of a label, or the label alone. */
export const withFailures = (label: string, failedCount: number): string =>
  failedCount > 0 ? `${label} · ${failedCount} failed` : label;

/**
 * A work group's label: its sentence, or "Thought for 2s" ("Thought" with no
 * measurable time) when it holds reasoning alone. A zero duration counts as
 * none: it means the items share a millisecond, and "0ms" reads as a broken
 * clock.
 */
export const workGroupLabel = (
  items: ReadonlyArray<ItemSnapshot>,
  durationMs: number | undefined,
): string => {
  const sentence = workSentence(items);
  if (sentence !== undefined) {
    return sentence;
  }
  return durationMs !== undefined && durationMs > 0
    ? `Thought for ${formatDurationMs(durationMs)}`
    : "Thought";
};

/** A settled turn's fold row: "Worked for 2m 3s", then what it did when it did anything. */
export const turnFoldLabel = (
  durationMs: number | undefined,
  sentence: string | undefined,
): string => {
  const lead =
    durationMs !== undefined && durationMs > 0
      ? `Worked for ${formatDurationMs(durationMs)}`
      : "Worked";
  return sentence === undefined ? lead : `${lead} · ${sentence}`;
};
