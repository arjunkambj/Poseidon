/**
 * What Settings → Import does with `sessions.importable`'s answer, apart from
 * drawing it: the sessions grouped by the folder they ran in, each row's
 * import state, and the runner that imports a selection one row at a time.
 *
 * The runner keeps going past a failed row (the row keeps its message and
 * offers Retry), and Stop takes effect between rows: the row being imported
 * finishes, the rows still queued go back to idle. Imports run one at a time
 * because the server serialises them anyway, and a row's state then always
 * says what the server is doing with it.
 */

import type { ThreadId } from "@poseidon/contracts/ids";
import type { ImportableSessionEntry } from "@poseidon/contracts/sessionImport";

/** A row's key: the instance whose files listed it and the harness's id for it. */
export const sessionKey = (entry: {
  readonly connectorInstanceId: string;
  readonly sourceId: string;
}): string => `${entry.connectorInstanceId}/${entry.sourceId}`;

/** The folder's last path segment, for a group's heading. */
export const folderName = (cwd: string): string => {
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? cwd;
};

export interface SessionGroup {
  readonly cwd: string;
  readonly name: string;
  /** The project already open on the folder, when one is. */
  readonly projectId: string | null;
  /** Newest first. */
  readonly entries: ReadonlyArray<ImportableSessionEntry>;
}

/**
 * The sessions by the folder they ran in: the group with the newest session
 * first, and newest first inside each group.
 */
export const groupSessions = (
  entries: ReadonlyArray<ImportableSessionEntry>,
): ReadonlyArray<SessionGroup> => {
  const newestFirst = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const byCwd = new Map<string, Array<ImportableSessionEntry>>();
  for (const entry of newestFirst) {
    const list = byCwd.get(entry.cwd);
    if (list === undefined) {
      byCwd.set(entry.cwd, [entry]);
    } else {
      list.push(entry);
    }
  }
  return Array.from(byCwd, ([cwd, list]) => ({
    cwd,
    name: folderName(cwd),
    projectId: list.find((entry) => entry.projectId !== null)?.projectId ?? null,
    entries: list,
  }));
};

export type RowState =
  | { readonly status: "idle" }
  | { readonly status: "queued" }
  | { readonly status: "importing" }
  | { readonly status: "imported"; readonly threadId: ThreadId }
  | { readonly status: "failed"; readonly message: string };

const IDLE: RowState = { status: "idle" };

/**
 * A row's state: what this page did with it, else imported when the list
 * names the thread that already holds it, else idle.
 */
export const rowState = (
  entry: ImportableSessionEntry,
  states: ReadonlyMap<string, RowState>,
): RowState =>
  states.get(sessionKey(entry)) ??
  (entry.importedThreadId === null
    ? IDLE
    : { status: "imported", threadId: entry.importedThreadId });

/** Whether a row can be ticked for Import selected. */
export const isSelectable = (state: RowState): boolean =>
  state.status === "idle" || state.status === "failed";

/** One row's import: the thread it made, or why it failed. */
export type ImportOutcome =
  | { readonly ok: true; readonly threadId: ThreadId }
  | { readonly ok: false; readonly message: string };

export interface ImportRun {
  /**
   * Stop after the row being imported; queued rows go back to idle. Answers
   * how many that puts back: none once the run has ended or already stopped.
   */
  readonly stop: () => number;
  /** Settles once the last row has, or the run has stopped. */
  readonly done: Promise<void>;
}

/**
 * Imports `keys` in order, one at a time, reporting every state change
 * through `onState`. A failed row (an `ok: false` outcome or a throw) is
 * reported and the run moves on to the next.
 */
export const runImports = (
  keys: ReadonlyArray<string>,
  importOne: (key: string) => Promise<ImportOutcome>,
  onState: (key: string, state: RowState) => void,
): ImportRun => {
  let stopped = false;
  let started = 0;
  let ended = false;
  for (const key of keys) {
    onState(key, { status: "queued" });
  }
  const done = (async () => {
    for (const [index, key] of keys.entries()) {
      if (stopped) {
        for (const rest of keys.slice(index)) {
          onState(rest, IDLE);
        }
        return;
      }
      started = index + 1;
      onState(key, { status: "importing" });
      let outcome: ImportOutcome;
      try {
        outcome = await importOne(key);
      } catch (error) {
        outcome = {
          ok: false,
          message: error instanceof Error ? error.message : "The session was not imported.",
        };
      }
      onState(
        key,
        outcome.ok
          ? { status: "imported", threadId: outcome.threadId }
          : { status: "failed", message: outcome.message },
      );
    }
  })().finally(() => {
    ended = true;
  });
  return {
    stop: () => {
      if (stopped || ended) return 0;
      stopped = true;
      return keys.length - started;
    },
    done,
  };
};
