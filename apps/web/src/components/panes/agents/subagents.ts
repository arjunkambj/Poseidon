/**
 * A thread's subagents, read out of its snapshot: every `task` row, with the
 * prompt it was given, where it stands and the last few rows it produced. The
 * Agents dock tab groups them; the strip above the composer counts the ones
 * still working.
 *
 * Nothing here is fetched or polled — the snapshot's items already carry it.
 * Items have no timestamps of their own: every time comes out of the UUIDv7
 * ids, as the timeline's "Worked for" does (`spanMs`).
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { uuidV7Millis } from "@poseidon/shared/ids";

import { spanMs } from "@/components/timeline/fold-rows";

export type SubagentState = "working" | "done" | "failed";

export interface Subagent {
  readonly item: ItemSnapshot;
  readonly title: string;
  /** What the subagent was asked to do: the call's `input.prompt`, trimmed. */
  readonly prompt?: string;
  readonly state: SubagentState;
  /** When the task row was opened, from its id. */
  readonly startedAt?: number;
  /** A settled task's span, from its own row to its last descendant's. */
  readonly durationMs?: number;
  /** The last few rows the subagent produced directly, in item order. */
  readonly recent: ReadonlyArray<ItemSnapshot>;
  /** Progress text a harness wrote into the task row itself, when it has no rows of its own. */
  readonly progress?: string;
}

export interface SubagentGroups {
  readonly working: ReadonlyArray<Subagent>;
  readonly done: ReadonlyArray<Subagent>;
  readonly failed: ReadonlyArray<Subagent>;
}

export interface AgentsStripSummary {
  readonly count: number;
  readonly newest: Subagent;
}

const RECENT_LIMIT = 5;

/** The disclosure id of a subagent's entry in the Agents tab. */
export const agentEntryRowId = (itemId: string): string => `agents:${itemId}`;

const promptOf = (item: ItemSnapshot): string | undefined => {
  const input = item.tool?.input;
  if (typeof input !== "object" || input === null || !("prompt" in input)) return undefined;
  const prompt = (input as { readonly prompt: unknown }).prompt;
  if (typeof prompt !== "string") return undefined;
  const trimmed = prompt.trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * A task still `in_progress` once its turn has settled did not finish: the
 * harness ended the turn under it, which reads the same as a harness reporting
 * it killed or stopped. Nothing settles such a row later, so it is only
 * working while its own turn is the one running — a row stranded by an
 * interrupted turn stays "did not finish" when the next turn starts. A row
 * with no turn stamp is read as belonging to the running turn.
 */
const stateOf = (item: ItemSnapshot, liveTurnId: string | null): SubagentState => {
  if (item.status === "completed") return "done";
  if (item.status === "failed") return "failed";
  const live = liveTurnId !== null && (item.turnId === undefined || item.turnId === liveTurnId);
  return live ? "working" : "failed";
};

const descendantsOf = (
  itemId: string,
  children: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>,
): ReadonlyArray<ItemSnapshot> => {
  const out: ItemSnapshot[] = [];
  const stack = [itemId];
  const seen = new Set<string>(stack);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.itemId)) continue;
      seen.add(child.itemId);
      out.push(child);
      stack.push(child.itemId);
    }
  }
  return out;
};

/**
 * Every task row in `items`, nested ones included, in item order.
 * `liveTurnId` is the thread's running turn (`snapshot.currentTurnId`), null
 * when none is.
 */
export const subagentsOf = (
  items: ReadonlyArray<ItemSnapshot>,
  liveTurnId: string | null,
): ReadonlyArray<Subagent> => {
  const children = new Map<string, ItemSnapshot[]>();
  for (const item of items) {
    if (item.parentItemId === undefined) continue;
    const list = children.get(item.parentItemId);
    if (list === undefined) children.set(item.parentItemId, [item]);
    else list.push(item);
  }

  const out: Subagent[] = [];
  for (const item of items) {
    if (item.kind !== "task") continue;
    const direct = children.get(item.itemId) ?? [];
    const state = stateOf(item, liveTurnId);
    const startedAt = uuidV7Millis(item.itemId);
    const prompt = promptOf(item);
    // Approximate: a settled task's end is its last descendant's start, since
    // rows carry no completion time of their own.
    const durationMs =
      state === "working" ? undefined : spanMs([item, ...descendantsOf(item.itemId, children)]);
    // Some harnesses report a delegation only as progress lines written into
    // the task row's `tool.output`, never as rows of its own.
    const output = item.tool?.output;
    const progress = direct.length === 0 && typeof output === "string" ? output : undefined;
    out.push({
      item,
      title: item.text || "Subagent task",
      state,
      recent: direct.slice(-RECENT_LIMIT),
      ...(prompt === undefined ? {} : { prompt }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(progress === undefined ? {} : { progress }),
    });
  }
  return out;
};

/** Newest first: by start time, then later in item order. */
const newestFirst = (list: ReadonlyArray<Subagent>): ReadonlyArray<Subagent> =>
  list
    .map((subagent, index) => ({ subagent, index }))
    .sort((a, b) => (b.subagent.startedAt ?? 0) - (a.subagent.startedAt ?? 0) || b.index - a.index)
    .map(({ subagent }) => subagent);

export const groupSubagents = (list: ReadonlyArray<Subagent>): SubagentGroups => ({
  working: newestFirst(list.filter((subagent) => subagent.state === "working")),
  done: newestFirst(list.filter((subagent) => subagent.state === "done")),
  failed: newestFirst(list.filter((subagent) => subagent.state === "failed")),
});

/** How many subagents are working and the newest of them; null when none is. */
export const agentsStripSummary = (
  items: ReadonlyArray<ItemSnapshot>,
  liveTurnId: string | null,
): AgentsStripSummary | null => {
  if (liveTurnId === null) return null;
  const working = groupSubagents(subagentsOf(items, liveTurnId)).working;
  const newest = working[0];
  return newest === undefined ? null : { count: working.length, newest };
};
