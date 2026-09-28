/**
 * How the Changes pane's file tree is laid out — presentation state, in memory
 * only, for the app session.
 *
 * Whether the tree shows beside the diffs is one choice for every thread; the
 * folders folded in it and the filter typed over it are each thread's own.
 * Both are `keepAlive`, because the pane unmounts every time the dock closes
 * or switches tab, and the tree has to come back the way it was left. Nothing
 * is stored: a relaunch starts with the tree shown and every folder open.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

const treeOpenAtom = Atom.keepAlive(Atom.make(true));

/** `[open, setOpen]` for the file tree beside the diffs; shown until turned off. */
export const useChangesTreeOpen = () => {
  const open = useAtomValue(treeOpenAtom);
  const setOpen = useAtomSet(treeOpenAtom);
  return [open, setOpen] as const;
};

/** One thread's tree: the folders folded (by full path) and the filter text. */
export interface ChangesTreeState {
  readonly collapsed: ReadonlySet<string>;
  readonly filter: string;
}

const emptyTreeState: ChangesTreeState = { collapsed: new Set(), filter: "" };

const treeStateAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, ChangesTreeState>>>({}));

/** One thread's tree state, and setters for its folders and its filter. */
export const useChangesTreeState = (threadId: string) => {
  const state = useAtomValue(
    treeStateAtom,
    React.useCallback(
      (states: Readonly<Record<string, ChangesTreeState>>) => states[threadId] ?? emptyTreeState,
      [threadId],
    ),
  );
  const setStates = useAtomSet(treeStateAtom);
  const update = React.useCallback(
    (change: (current: ChangesTreeState) => ChangesTreeState) =>
      setStates((states) => ({
        ...states,
        [threadId]: change(states[threadId] ?? emptyTreeState),
      })),
    [setStates, threadId],
  );
  const setFolderOpen = React.useCallback(
    (path: string, open: boolean) =>
      update((current) => {
        const collapsed = new Set(current.collapsed);
        if (open) {
          collapsed.delete(path);
        } else {
          collapsed.add(path);
        }
        return { ...current, collapsed };
      }),
    [update],
  );
  const setFilter = React.useCallback(
    (filter: string) => update((current) => ({ ...current, filter })),
    [update],
  );
  return { ...state, setFolderOpen, setFilter };
};
