/**
 * Turns a flat `ItemSnapshot[]` into the rows the timeline renders.
 *
 * Items are grouped into turns first (`turns.ts`): a `user_message` opens
 * one, a message steered into a running turn shares its id and stays inside
 * it, and task children nest under their task. Then each turn renders by how
 * far along it is:
 *
 * - The live turn — the last one while a turn runs — folds each run of work
 *   (reasoning included) into a `work-group` burst from its first step, keyed
 *   by that step, so the row keeps its key as steps stream in; narration,
 *   todos, plans, errors, compactions, steered messages and decisions split
 *   the runs and stay inline. The trailing burst, when nothing comes after
 *   it, is marked `live`: it is the work still going on. A `working` row with
 *   its clock ends the turn. Once the turn settles it folds as below.
 * - A settled turn opened by a user message shows the message, then ONE
 *   `turn-fold` row, "Worked for 2m 3s · Ran 3 commands, edited 2 files"
 *   (`work-summary.ts`), standing for its work: work kinds, reasoning and the
 *   interim narration between them. What the reader needs without opening
 *   it stays visible under it in order — todos, plans, errors, compactions,
 *   steered messages, answered decisions — then the final answer (its last
 *   `assistant_message`, which carries `turnEnd` for its footer) and, when
 *   the turn changed files, the `turn-summary` card. The answer is the last
 *   message only when no work follows it: a turn that ended in work
 *   (interrupted, failed) has no answer, folds all of its narration with the
 *   work, and keeps its errors in view.
 * - Opening the fold (`isFoldOpen`) puts the hidden rows back as top-level
 *   rows in their original order, each run of work kinds as a `work-group`,
 *   rather than as one body inside the fold row: a single tall row would
 *   defeat the virtualizer and mount every hidden diff at once.
 * - The leading turn (rows before the first user message) has no fold: its
 *   runs of work fold into work groups and nothing else.
 *
 * A turn summary names the checkpoint its turn left behind, when there is one:
 * the turn's id looked up in the thread's checkpoints — so its "Open in
 * Changes" can show that very turn.
 *
 * Answered approvals, questions and plans come in as `ResolvedDecision`s and
 * land as one `decision` row right after the row holding their `afterItemId`
 * — a work group ends there, so the record sits between what came before the
 * answer and what came after it. A record stays visible when its anchor is
 * folded away. A record with no anchor, or one that names no item, goes at
 * the end.
 *
 * Durations come out of the UUIDv7 ids, which carry their creation
 * millisecond in the leading 48 bits (`fold-rows.ts`). An id marks when its
 * item started, so a settled turn's time runs on to when the turn ended where
 * that is known (`turnEndedAt`), rather than stopping as its answer began.
 */

import type { ResolvedDecision } from "@poseidon/contracts/decisions";
import type { TurnId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { uuidV7Millis } from "@poseidon/shared/ids";

import {
  FOLDABLE_KINDS,
  spanMs,
  type TimelineTurnFoldRow,
  type TimelineTurnSummaryRow,
  type TimelineWorkGroupRow,
  turnFoldRow,
  turnSummaryRow,
  withChildren,
  workGroupRow,
} from "./fold-rows";
import { anchorDecisions, groupTurns, nestTaskChildren, type Turn } from "./turns";

export type {
  TimelineTurnFoldRow,
  TimelineTurnSummaryRow,
  TimelineWorkGroupRow,
  TurnSummaryFile,
} from "./fold-rows";

/** Marks the final answer of a settled turn, for the footer under it. */
export interface TurnEnd {
  readonly turnId: TurnId | undefined;
  /** The turn's first item to its end, task children included (`spanMs`). */
  readonly durationMs: number | undefined;
}

export interface TimelineItemRow {
  readonly kind: "item";
  readonly id: string;
  readonly item: ItemSnapshot;
  /** Set on the last `assistant_message` of each settled turn only. */
  readonly turnEnd?: TurnEnd;
  /**
   * Set on a `user_message` steered into a turn already running: it shares
   * that turn's id, so restoring to before it undoes the whole turn.
   */
  readonly steered?: true;
}

/** The one-line record of an answered approval, question or plan. */
export interface TimelineDecisionRow {
  readonly kind: "decision";
  readonly id: string;
  readonly decision: ResolvedDecision;
}

/** Trailing "Working…" row shown while a turn is open. */
export interface TimelineWorkingRow {
  readonly kind: "working";
  readonly id: string;
  /** Epoch ms the running turn began, for its elapsed clock; undefined when unknown. */
  readonly startedAt: number | undefined;
}

export type TimelineRow =
  | TimelineItemRow
  | TimelineWorkGroupRow
  | TimelineTurnFoldRow
  | TimelineTurnSummaryRow
  | TimelineDecisionRow
  | TimelineWorkingRow;

export interface TimelineProjection {
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}

export interface BuildTimelineOptions {
  readonly turnActive: boolean;
  /**
   * When the running turn began, if known — the caller reads it off the turn
   * id. Without it the working row falls back to the last user message, since
   * a turn counts as in flight before its id is filled in.
   */
  readonly turnStartedAt?: number | undefined;
  /** The thread's answered decisions, oldest first (`snapshot.decisions`). */
  readonly decisions?: ReadonlyArray<ResolvedDecision> | undefined;
  /** The thread's checkpoints (`snapshot.checkpoints`), for the turn summaries' links. */
  readonly checkpoints?:
    | ReadonlyArray<{ readonly turnId: string; readonly ref: string }>
    | undefined;
  /**
   * When each settled turn ended, epoch ms (`turnEndTimes`: its checkpoint's
   * capture). Without an entry a turn's time ends at its last item's start.
   */
  readonly turnEndedAt?: ReadonlyMap<TurnId, number> | undefined;
  /** Whether the `turn-fold` row with this id is open; every fold is closed without it. */
  readonly isFoldOpen?: ((rowId: string) => boolean) | undefined;
}

/** Every fold open: the projection `timeline.expandAll` walks for its ids. */
export const ALL_FOLDS_OPEN = (): boolean => true;

/**
 * A settled turn's final answer: its last `assistant_message`, when no work
 * follows it. A turn that ended in work — interrupted, failed, or cut off
 * mid-step — has none, and its last narration folds with the rest: shown
 * above a fold standing for the commands that ran after it, it would read as
 * the answer and tell the story out of order.
 */
const finalAnswer = (items: ReadonlyArray<ItemSnapshot>): ItemSnapshot | undefined => {
  const lastWork = items.findLastIndex((item) => FOLDABLE_KINDS.has(item.kind));
  return items.slice(lastWork + 1).findLast((item) => item.kind === "assistant_message");
};

/** The start of the running turn: the given time, else the last user message's id. */
const workingStartedAt = (
  roots: ReadonlyArray<ItemSnapshot>,
  turnStartedAt: number | undefined,
): number | undefined => {
  if (turnStartedAt !== undefined) {
    return turnStartedAt;
  }
  const lastMessage = roots.findLast((item) => item.kind === "user_message");
  return lastMessage === undefined ? undefined : uuidV7Millis(lastMessage.itemId);
};

export const buildTimeline = (
  items: ReadonlyArray<ItemSnapshot>,
  options: BuildTimelineOptions,
): TimelineProjection => {
  const { byId, roots, childrenByParent } = nestTaskChildren(items);
  const decisions = anchorDecisions(options.decisions ?? [], byId);
  const isFoldOpen = options.isFoldOpen ?? (() => false);
  const rows: TimelineRow[] = [];

  // Row ids must be unique for the list; a repeated id (a plan revised twice
  // in one turn) takes a counter.
  const usedDecisionIds = new Set<string>();
  const pushDecisions = (records: ReadonlyArray<ResolvedDecision> | undefined) => {
    for (const decision of records ?? []) {
      let id = `decision:${decision.id}`;
      for (let n = 2; usedDecisionIds.has(id); n += 1) {
        id = `decision:${decision.id}:${n}`;
      }
      usedDecisionIds.add(id);
      rows.push({ kind: "decision", id, decision });
    }
  };

  /**
   * Rows in order with each maximal run of work kinds folded into a work
   * group. A decision is not work: it closes the run, and the next one starts
   * fresh.
   */
  const pushWorkRuns = (
    run: ReadonlyArray<ItemSnapshot>,
    itemRow: (item: ItemSnapshot) => TimelineItemRow,
  ) => {
    let pending: ItemSnapshot[] = [];
    const flush = () => {
      if (pending.length > 0) {
        rows.push(workGroupRow(pending));
        pending = [];
      }
    };
    for (const item of run) {
      const after = decisions.after.get(item.itemId);
      if (FOLDABLE_KINDS.has(item.kind)) {
        pending.push(item);
        if (after !== undefined) {
          flush();
        }
      } else {
        flush();
        rows.push(itemRow(item));
      }
      pushDecisions(after);
    }
    flush();
  };

  const turns = groupTurns(roots);
  const openers = new Set(turns.map((turn) => turn.opener?.itemId));
  const plainRow = (item: ItemSnapshot): TimelineItemRow =>
    item.kind === "user_message" && !openers.has(item.itemId)
      ? { kind: "item", id: item.itemId, item, steered: true }
      : { kind: "item", id: item.itemId, item };

  const checkpointRefByTurn = new Map<string, string>(
    (options.checkpoints ?? []).map((checkpoint) => [checkpoint.turnId, checkpoint.ref]),
  );

  const pushSettledTurn = (turn: Turn, opener: ItemSnapshot) => {
    const answer = finalAnswer(turn.items);
    const all = withChildren(turn.items, childrenByParent);
    const endedAt = turn.turnId === undefined ? undefined : options.turnEndedAt?.get(turn.turnId);
    const durationMs = spanMs(all, endedAt);
    const itemRow = (item: ItemSnapshot): TimelineItemRow =>
      item === answer
        ? { ...plainRow(item), turnEnd: { turnId: item.turnId ?? turn.turnId, durationMs } }
        : plainRow(item);
    const folds = (item: ItemSnapshot): boolean =>
      FOLDABLE_KINDS.has(item.kind) || (item.kind === "assistant_message" && item !== answer);

    const rest = turn.items.slice(1);
    const hidden = rest.filter(folds);
    rows.push(plainRow(opener));
    pushDecisions(decisions.after.get(opener.itemId));
    if (hidden.length === 0) {
      pushWorkRuns(rest, itemRow);
    } else {
      const fold = turnFoldRow(opener, hidden, durationMs);
      rows.push(fold);
      if (isFoldOpen(fold.id)) {
        pushWorkRuns(rest, itemRow);
      } else {
        for (const item of rest) {
          if (!folds(item)) {
            rows.push(itemRow(item));
          }
          pushDecisions(decisions.after.get(item.itemId));
        }
      }
    }
    const summary = turnSummaryRow(opener, turn.turnId, all, checkpointRefByTurn);
    if (summary !== undefined) {
      rows.push(summary);
    }
  };

  turns.forEach((turn, index) => {
    if (options.turnActive && index === turns.length - 1) {
      const start = rows.length;
      pushWorkRuns(turn.items, plainRow);
      const last = rows.at(-1);
      if (rows.length > start && last?.kind === "work-group") {
        rows[rows.length - 1] = workGroupRow(last.items, true);
      }
    } else if (turn.opener === undefined) {
      pushWorkRuns(turn.items, plainRow);
    } else {
      pushSettledTurn(turn, turn.opener);
    }
  });

  pushDecisions(decisions.trailing);

  if (options.turnActive) {
    rows.push({
      kind: "working",
      id: "working",
      startedAt: workingStartedAt(roots, options.turnStartedAt),
    });
  }

  return { rows, childrenByParent };
};
