/**
 * The terminal drawer's tabs for each owner — a thread, or on the New task
 * page a project: which terminals it shows, in what order, and which one is
 * in front.
 *
 * The server's `terminal.list` is the truth about which terminals exist; the
 * reducer only adds what the list cannot say — the active tab, and what this
 * client just did before the next listing arrives. `synced` folds a listing
 * back in, so a terminal another window closed, or one a server restart
 * forgot, drops out here too.
 *
 * Kept in memory, keyed by the owner's `terminalOwnerKey`, in a `keepAlive`
 * map for the same reason as the composer draft (`composerDraftAtom` in
 * `@/state/ui`): the only subscriber is the drawer on screen, and without
 * `keepAlive` switching threads would throw away the very state that
 * switching back is supposed to find. When the New task page hands its
 * project's terminals to the thread it just started, their tabs move with
 * them once the move is known (`handOverDrawerState`, run by
 * `./terminal-hand-over`), the one in front still in front.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TerminalId } from "@poseidon/contracts/ids";
import type { TerminalScript, TerminalSummary } from "@poseidon/contracts/terminal";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

export interface TerminalTab {
  readonly terminalId: TerminalId;
  readonly title: string;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  /** The script the terminal runs as its own process, or null for a shell. */
  readonly script: TerminalScript | null;
}

export interface DrawerState {
  readonly tabs: ReadonlyArray<TerminalTab>;
  readonly activeId: TerminalId | null;
}

export type DrawerAction =
  | { readonly type: "synced"; readonly terminals: ReadonlyArray<TerminalSummary> }
  | { readonly type: "opened"; readonly terminal: TerminalSummary }
  | { readonly type: "closed"; readonly terminalId: TerminalId }
  | { readonly type: "exited"; readonly terminalId: TerminalId; readonly exitCode: number | null }
  | { readonly type: "activated"; readonly terminalId: TerminalId };

export const emptyDrawerState: DrawerState = { tabs: [], activeId: null };

const tabOf = (terminal: TerminalSummary): TerminalTab => ({
  terminalId: terminal.terminalId,
  title: terminal.title,
  status: terminal.status,
  exitCode: terminal.exitCode,
  script: terminal.script ?? null,
});

/**
 * The tab to show once `removed` is gone: the one after it, or the one before
 * when it was last.
 */
const neighbourOf = (tabs: ReadonlyArray<TerminalTab>, removed: TerminalId): TerminalId | null => {
  const index = tabs.findIndex((tab) => tab.terminalId === removed);
  const rest = tabs.filter((tab) => tab.terminalId !== removed);
  if (rest.length === 0) {
    return null;
  }
  return rest[Math.min(Math.max(index, 0), rest.length - 1)]!.terminalId;
};

export const reduceDrawer = (state: DrawerState, action: DrawerAction): DrawerState => {
  switch (action.type) {
    case "synced": {
      // Server order; an exit this client already saw is not undone by a
      // listing taken a moment before it.
      const tabs = action.terminals.map((terminal) => {
        const known = state.tabs.find((tab) => tab.terminalId === terminal.terminalId);
        return known?.status === "exited" && terminal.status === "running"
          ? known
          : tabOf(terminal);
      });
      const activeId = tabs.some((tab) => tab.terminalId === state.activeId)
        ? state.activeId
        : (tabs.at(-1)?.terminalId ?? null);
      return { tabs, activeId };
    }
    case "opened": {
      const tab = tabOf(action.terminal);
      const exists = state.tabs.some((entry) => entry.terminalId === tab.terminalId);
      return {
        tabs: exists
          ? state.tabs.map((entry) => (entry.terminalId === tab.terminalId ? tab : entry))
          : [...state.tabs, tab],
        activeId: tab.terminalId,
      };
    }
    case "closed": {
      if (!state.tabs.some((tab) => tab.terminalId === action.terminalId)) {
        return state;
      }
      return {
        tabs: state.tabs.filter((tab) => tab.terminalId !== action.terminalId),
        activeId:
          state.activeId === action.terminalId
            ? neighbourOf(state.tabs, action.terminalId)
            : state.activeId,
      };
    }
    case "exited":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.terminalId === action.terminalId
            ? { ...tab, status: "exited", exitCode: action.exitCode }
            : tab,
        ),
      };
    case "activated":
      return state.tabs.some((tab) => tab.terminalId === action.terminalId)
        ? { ...state, activeId: action.terminalId }
        : state;
  }
};

/**
 * The states after `from`'s terminals were handed to `to`: `from`'s tabs
 * join `to`'s — after any `to` already had, which a fresh thread has none of —
 * and `from` keeps nothing. The tab in front stays in front: `to`'s own, when
 * it had one, else `from`'s.
 */
export const handOverDrawerState = (
  states: Readonly<Record<string, DrawerState>>,
  from: string,
  to: string,
): Readonly<Record<string, DrawerState>> => {
  const moving = states[from];
  if (moving === undefined) {
    return states;
  }
  const held = states[to] ?? emptyDrawerState;
  const tabs = [
    ...held.tabs,
    ...moving.tabs.filter((tab) => !held.tabs.some((own) => own.terminalId === tab.terminalId)),
  ];
  const { [from]: _moved, ...rest } = states;
  return { ...rest, [to]: { tabs, activeId: held.activeId ?? moving.activeId } };
};

/** `Terminal N` with the smallest N no tab is titled with. */
export const nextTitle = (tabs: ReadonlyArray<Pick<TerminalTab, "title">>): string => {
  const taken = new Set(tabs.map((tab) => tab.title));
  let n = 1;
  while (taken.has(`Terminal ${n}`)) {
    n += 1;
  }
  return `Terminal ${n}`;
};

/** Every owner's tabs, by owner key; read directly only by the New task hand-over. */
export const drawerStatesAtom = Atom.keepAlive(
  Atom.make<Readonly<Record<string, DrawerState>>>({}),
);

/** Moves one owner's tabs to another's (`handOverDrawerState`). */
export const useDrawerStateHandOver = () => {
  const setStates = useAtomSet(drawerStatesAtom);
  return React.useCallback(
    (from: string, to: string) => setStates((states) => handOverDrawerState(states, from, to)),
    [setStates],
  );
};

/** One owner's tabs, and the dispatch that changes them. */
export const useDrawerState = (threadId: string) => {
  const state = useAtomValue(
    drawerStatesAtom,
    React.useCallback(
      (states: Readonly<Record<string, DrawerState>>) => states[threadId] ?? emptyDrawerState,
      [threadId],
    ),
  );
  const setStates = useAtomSet(drawerStatesAtom);
  const dispatch = React.useCallback(
    (action: DrawerAction) =>
      setStates((states) => {
        const current = states[threadId] ?? emptyDrawerState;
        const next = reduceDrawer(current, action);
        return next === current ? states : { ...states, [threadId]: next };
      }),
    [setStates, threadId],
  );
  return [state, dispatch] as const;
};
