/**
 * The rows `buildTimeline` (`fold.ts`) makes out of a turn's items: the
 * `turn-fold` row that stands for a settled turn's work, the `work-group` fold
 * over a run of work (settled or still running), and the `turn-summary` card of the files a turn changed
 * — plus the span of time a turn's items cover, which the fold row and the
 * final answer's footer both report.
 *
 * Durations come out of the UUIDv7 ids, which carry their creation
 * millisecond in the leading 48 bits. A settled turn's span ends at its
 * checkpoint when it has one, taken as the turn completed.
 */

import type { ItemKind } from "@poseidon/contracts/enums";
import type { TurnId } from "@poseidon/contracts/ids";
import type { FileChangeKind, ItemSnapshot } from "@poseidon/contracts/runtime";
import { uuidV7Millis } from "@poseidon/shared/ids";

import { countFailed, mergeKind, workSentence } from "@/components/timeline/work-summary";
import { diffStats } from "@/lib/diff-stats";

/**
 * One folded run of work rows. Its label is `workGroupLabel` over `items`.
 * Its id is its first item's, so a burst in the running turn keeps its key as
 * steps stream in and matches the group the same run becomes in an opened
 * settled fold.
 */
export interface TimelineWorkGroupRow {
  readonly kind: "work-group";
  readonly id: string;
  readonly items: ReadonlyArray<ItemSnapshot>;
  readonly failedCount: number;
  readonly durationMs: number | undefined;
  /**
   * True only for the running turn's last burst — the work still going on —
   * even when the answers to approvals it asked for sit after it.
   */
  readonly live: boolean;
}

/**
 * The one row a settled turn's work folds into: "Worked for 2m 3s · Ran 3
 * commands, edited 2 files". Opening it puts the hidden rows back into the
 * list, in order, right under it.
 */
export interface TimelineTurnFoldRow {
  readonly kind: "turn-fold";
  readonly id: string;
  /** The whole turn, first item to its end (`spanMs`), task children included. */
  readonly durationMs: number | undefined;
  /** What the hidden work did (`workSentence`); undefined when it holds no action. */
  readonly sentence: string | undefined;
  readonly failedCount: number;
}

/** One changed path in a turn summary, its diffs summed across the turn. */
export interface TurnSummaryFile {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly added: number;
  readonly removed: number;
}

/** The card after a settled turn's answer: the files it changed, with Undo. */
export interface TimelineTurnSummaryRow {
  readonly kind: "turn-summary";
  readonly id: string;
  /** The turn to undo: its checkpoint-before is where Undo goes back to. */
  readonly turnId: TurnId | undefined;
  readonly files: ReadonlyArray<TurnSummaryFile>;
  readonly added: number;
  readonly removed: number;
  /** The ref of the checkpoint the turn left, for the Changes pane; undefined when it has none. */
  readonly checkpointRef: string | undefined;
}

/** Work kinds: they narrate process, not content, so they fold when settled. */
export const FOLDABLE_KINDS: ReadonlySet<ItemKind> = new Set([
  "reasoning",
  "command_execution",
  "file_change",
  "tool_call",
  "mcp_tool_call",
  "web_search",
  "task",
  "skill",
]);

/**
 * A run of work as one row. Its time runs from its first step's start to
 * `endMs` — the start of whatever came after the run, when something did — or
 * else to its last step's start: an item's id records when it began, not when
 * it finished, so a lone thought is only timed by what followed it.
 */
export const workGroupRow = (
  items: ReadonlyArray<ItemSnapshot>,
  live = false,
  endMs?: number | undefined,
): TimelineWorkGroupRow => {
  const firstMs = uuidV7Millis(items[0].itemId);
  const lastMs = uuidV7Millis(items[items.length - 1].itemId);
  const untilMs = lastMs === undefined || endMs === undefined ? lastMs : Math.max(lastMs, endMs);
  const durationMs =
    firstMs !== undefined && untilMs !== undefined ? Math.max(0, untilMs - firstMs) : undefined;
  return {
    kind: "work-group",
    id: `work-group:${items[0].itemId}`,
    items,
    failedCount: countFailed(items),
    durationMs,
    live,
  };
};

export const turnFoldRow = (
  opener: ItemSnapshot,
  hidden: ReadonlyArray<ItemSnapshot>,
  durationMs: number | undefined,
): TimelineTurnFoldRow => ({
  kind: "turn-fold",
  id: `turn-fold:${opener.itemId}`,
  durationMs,
  sentence: workSentence(hidden),
  failedCount: countFailed(hidden),
});

/** Every item under `roots`, task children at any depth included. */
export const withChildren = (
  roots: ReadonlyArray<ItemSnapshot>,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>,
): ReadonlyArray<ItemSnapshot> => {
  const all: ItemSnapshot[] = [];
  const visit = (item: ItemSnapshot) => {
    all.push(item);
    for (const child of childrenByParent.get(item.itemId) ?? []) {
      visit(child);
    }
  };
  roots.forEach(visit);
  return all;
};

/**
 * Earliest item to latest, or to `endMs` when that is later; undefined when
 * the ids carry no time or no span. An item's id records when it started, so
 * the last item's own time leaves out how long it ran — the answer streaming,
 * the last command — and a known end (`turnEndTimes`) closes that gap.
 */
export const spanMs = (
  items: ReadonlyArray<ItemSnapshot>,
  endMs?: number | undefined,
): number | undefined => {
  let firstMs: number | undefined;
  let lastMs: number | undefined = endMs;
  for (const item of items) {
    const ms = uuidV7Millis(item.itemId);
    if (ms !== undefined) {
      firstMs = firstMs === undefined ? ms : Math.min(firstMs, ms);
      lastMs = lastMs === undefined ? ms : Math.max(lastMs, ms);
    }
  }
  return firstMs !== undefined && lastMs !== undefined && lastMs > firstMs
    ? lastMs - firstMs
    : undefined;
};

/**
 * The files a turn changed, task children included, or `undefined` when it
 * changed none: a turn that only read and ran things has no card.
 */
export const turnSummaryRow = (
  opener: ItemSnapshot,
  turnId: TurnId | undefined,
  all: ReadonlyArray<ItemSnapshot>,
  checkpointRefByTurn: ReadonlyMap<string, string>,
): TimelineTurnSummaryRow | undefined => {
  const files = new Map<string, TurnSummaryFile>();
  for (const item of all) {
    const change = item.kind === "file_change" ? item.fileChange : undefined;
    if (change !== undefined) {
      const stats = change.diff === undefined ? { added: 0, removed: 0 } : diffStats(change.diff);
      const seen = files.get(change.path);
      files.set(change.path, {
        path: change.path,
        kind: seen === undefined ? change.kind : mergeKind(seen.kind, change.kind),
        added: (seen?.added ?? 0) + stats.added,
        removed: (seen?.removed ?? 0) + stats.removed,
      });
    }
  }
  if (files.size === 0) {
    return undefined;
  }
  const list = [...files.values()];
  return {
    kind: "turn-summary",
    id: `turn-summary:${opener.itemId}`,
    turnId,
    files: list,
    added: list.reduce((sum, file) => sum + file.added, 0),
    removed: list.reduce((sum, file) => sum + file.removed, 0),
    checkpointRef: turnId === undefined ? undefined : checkpointRefByTurn.get(turnId),
  };
};
