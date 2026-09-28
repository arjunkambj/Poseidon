/**
 * The sidebar's undo stack.
 *
 * Archive, pin and unpin, mark unread and rename each push one entry that
 * puts things back (`./use-sidebar-actions`). Two things take entries off it:
 * the "Undo" button on an archive toast, which undoes that one entry, and
 * `sidebar.undo` (`Mod+Z` outside text fields, the terminal and the browser),
 * which undoes the newest. An entry leaves the stack *before* it runs, so the
 * toast and the key can never run the same one twice.
 *
 * The stack is this window's and lives only in memory: an undo is for the
 * action just taken, not for yesterday's.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

export interface UndoEntry {
  readonly id: string;
  /** What the entry undoes, for a reader of the stack ("Archive", "Pin"). */
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export type UndoStack = ReadonlyArray<UndoEntry>;

/** Enough for a burst of tidying; older entries fall off the bottom. */
const UNDO_LIMIT = 20;

/** The stack with `entry` on top (last), trimmed to the newest `limit`. */
export const pushUndo = (stack: UndoStack, entry: UndoEntry, limit = UNDO_LIMIT): UndoStack => {
  const next = [...stack, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
};

/** `[newest entry, the rest]`; `[undefined, stack]` when it is empty. */
export const takeLatest = (stack: UndoStack): readonly [UndoEntry | undefined, UndoStack] =>
  stack.length === 0 ? [undefined, stack] : [stack[stack.length - 1], stack.slice(0, -1)];

/** `[the entry with id, the rest]`; `[undefined, stack]` when it has gone. */
export const takeById = (
  stack: UndoStack,
  id: string,
): readonly [UndoEntry | undefined, UndoStack] => {
  const entry = stack.find((candidate) => candidate.id === id);
  return entry === undefined ? [undefined, stack] : [entry, stack.filter((item) => item !== entry)];
};

/**
 * What undoing an archive has to restore beyond the unarchive itself: the
 * threads that were pinned (archiving unpins), and the thread to reopen when
 * the one on screen was among them.
 */
export const archiveUndoPlan = <Id extends string>(
  threadIds: ReadonlyArray<Id>,
  pins: ReadonlyArray<string>,
  openThreadId: string | null,
): { readonly repin: ReadonlyArray<Id>; readonly reopen: Id | null } => ({
  repin: threadIds.filter((id) => pins.includes(id)),
  reopen: threadIds.find((id) => id === openThreadId) ?? null,
});

// `keepAlive`: the toast's Undo can outlive every component that reads the stack.
const undoAtom = Atom.keepAlive(Atom.make<UndoStack>([]));

let nextId = 0;
/** A fresh entry id, unique within this window. */
export const makeUndoId = (): string => `undo-${++nextId}`;

/** `{ push, undo(id), undoLatest, canUndo }` over the one stack. */
export const useSidebarUndo = () => {
  const stack = useAtomValue(undoAtom);
  const setStack = useAtomSet(undoAtom);

  const push = React.useCallback(
    (entry: UndoEntry) => setStack((current) => pushUndo(current, entry)),
    [setStack],
  );
  // The setter applies its update synchronously, so `taken` is set on return.
  const take = React.useCallback(
    (pick: (current: UndoStack) => readonly [UndoEntry | undefined, UndoStack]) => {
      const taken: { entry?: UndoEntry } = {};
      setStack((current) => {
        const [entry, rest] = pick(current);
        if (entry !== undefined) {
          taken.entry = entry;
        }
        return rest;
      });
      void taken.entry?.run();
    },
    [setStack],
  );
  const undo = React.useCallback((id: string) => take((current) => takeById(current, id)), [take]);
  const undoLatest = React.useCallback(() => take(takeLatest), [take]);

  return { push, undo, undoLatest, canUndo: stack.length > 0 };
};
