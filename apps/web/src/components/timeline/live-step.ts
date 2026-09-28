/**
 * The words on a running turn's live work line: the newest step of the burst
 * as a sentence with a short target — "Running pnpm test" while it runs, "Ran
 * pnpm test" once it is done. Where a settled work group says what the whole
 * run did (`work-summary.ts`), the live line says what is happening now.
 *
 * A step is sorted by the same classifier the settled sentence uses
 * (`workAction`), so the two never disagree about what an item was. Targets
 * are cut to one short line: a command's first line, a file's name, a search's
 * pattern. Reasoning reads "Thinking…" while it streams, then "Thought for 4s"
 * once it is over. An item carries no end time of its own, only the
 * millisecond its UUIDv7 id records, so the row passes the moment it saw the
 * reasoning finish (`use-step-ended-at.ts`); without one — a thread opened
 * after the fact — it reads plain "Thought".
 *
 * Pure and cheap: `buildTimeline` reruns on every streamed delta, and the row
 * memoises the label on its items.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { uuidV7Millis } from "@poseidon/shared/ids";

import { browserToolLabel } from "@/components/timeline/browser-tool";
import { baseName } from "@/components/timeline/path-links";
import { toolPathTarget, toolTarget } from "@/components/timeline/tool-target";
import { type ClauseKind, workAction } from "@/components/timeline/work-summary";
import { formatDurationMs } from "@/lib/format";

/** A verb in its two tenses: while the step runs, and once it is over. */
type Verb = readonly [present: string, past: string];

const VERB: Readonly<Partial<Record<ClauseKind, Verb>>> = {
  command: ["Running", "Ran"],
  edit: ["Editing", "Edited"],
  create: ["Creating", "Created"],
  delete: ["Deleting", "Deleted"],
  read: ["Reading", "Read"],
  search: ["Searching", "Searched"],
  list: ["Listing", "Listed"],
  "web-search": ["Searching the web", "Searched the web"],
  fetch: ["Fetching", "Fetched"],
  mcp: ["Calling", "Called"],
  tool: ["Using", "Used"],
};

/** The keys a search step's target comes from, before any path it names. */
const SEARCH_KEYS = ["pattern", "query"] as const;

/** The input's search keys alone, so `toolTarget` reads the pattern, not the path. */
const searchInput = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null) return {};
  const record = input as Record<string, unknown>;
  return Object.fromEntries(SEARCH_KEYS.map((key) => [key, record[key]]));
};

const fileName = (path: string | undefined): string | undefined =>
  path === undefined ? undefined : baseName(path) || path;

/** The short target after the verb, by kind of step. */
const target = (item: ItemSnapshot, kind: ClauseKind): string | undefined => {
  const input = item.tool?.input;
  switch (kind) {
    case "command":
      return toolTarget({ command: item.command?.cmd ?? item.text }) ?? toolTarget(input);
    case "edit":
    case "create":
    case "delete":
    case "read":
      return fileName(item.fileChange?.path ?? toolPathTarget(input));
    case "search":
    case "web-search":
      return toolTarget(searchInput(input)) ?? toolTarget(input);
    case "list":
    case "fetch":
      return toolTarget(input);
    case "mcp":
    case "tool":
      return item.tool?.name;
    default:
      return undefined;
  }
};

/** How long a reasoning item ran: from its start to `endedAt`, when that is known. */
const thoughtLabel = (item: ItemSnapshot, endedAt: number | undefined): string => {
  const startMs = uuidV7Millis(item.itemId);
  return startMs !== undefined && endedAt !== undefined && endedAt > startMs
    ? `Thought for ${formatDurationMs(endedAt - startMs)}`
    : "Thought";
};

/**
 * A live burst's line: its newest step as a sentence. `endedAt` is when that
 * step finished, epoch ms, when the caller knows it — it times a thought.
 */
export const liveStepLabel = (
  items: ReadonlyArray<ItemSnapshot>,
  endedAt?: number | undefined,
): string => {
  const item = items.at(-1);
  if (item === undefined) return "Working…";
  const running = item.status === "in_progress";
  if (item.kind === "reasoning") {
    return running ? "Thinking…" : thoughtLabel(item, endedAt);
  }
  const action = workAction(item);
  if (action === null) return "Working…";
  switch (action.kind) {
    case "browser":
      return browserToolLabel(item.tool?.name ?? "", item.tool?.input) ?? "Used the browser";
    case "task":
      return item.text ?? "Subagent task";
    case "skill":
      return item.text ?? "Skill";
    default: {
      const [present, past] = VERB[action.kind] ?? ["Using", "Used"];
      const verb = running ? present : past;
      const what = target(item, action.kind);
      if (what === undefined) return verb;
      return action.kind === "web-search" ? `${verb} for ${what}` : `${verb} ${what}`;
    }
  }
};

/** How many steps a live burst holds; the row shows "N steps" only past one. */
export const liveStepCount = (items: ReadonlyArray<ItemSnapshot>): number => items.length;
