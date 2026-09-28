/**
 * The terminal drawer's layout: whether each owner's drawer is open — a
 * thread's, on the New task page a project's, or in first-run setup home's,
 * keyed by `terminalOwnerKey` (a thread's bare id, `project:<id>` or `home`)
 * — and how tall the drawer is. Both
 * persist through localStorage — durable layout, nothing more — the way the
 * dock's width and tab do in `@/state/ui`.
 *
 * The tabs themselves are not here: which terminals an owner has is the
 * server's to say, and the drawer keeps its view of them in
 * `@/components/terminal/drawer-state`.
 *
 * When the New task page hands its project's terminals to the thread it just
 * started (`terminal.adopt`), an open drawer goes with them: the hand-over
 * closes the project's first and opens the thread's once the move is known
 * (`useSetDrawerOpen`, driven by `@/components/terminal/terminal-hand-over`).
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

const OPEN_KEY = "poseidon:terminal-open-by-thread";

/**
 * Absent, unparseable or foreign-shaped storage all mean "no drawer open".
 * Only `true` entries are kept: a closed drawer is the absence of a key.
 */
export const parseOpenByThread = (
  raw: string | null | undefined,
): Readonly<Record<string, true>> => {
  if (raw === null || raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry) => entry[1] === true)
        .map(([threadId]) => [threadId, true as const]),
    );
  } catch {
    return {};
  }
};

/** The map with one thread's drawer set; closing drops the key. */
export const withDrawerOpen = (
  openByThread: Readonly<Record<string, true>>,
  threadId: string,
  open: boolean,
): Readonly<Record<string, true>> => {
  if (open === (openByThread[threadId] === true)) {
    return openByThread;
  }
  const next = { ...openByThread };
  if (open) {
    next[threadId] = true;
  } else {
    delete next[threadId];
  }
  return next;
};

const readOpenByThread = (): Readonly<Record<string, true>> => {
  try {
    return parseOpenByThread(globalThis.localStorage?.getItem(OPEN_KEY));
  } catch {
    // Reading localStorage itself throws when site data is blocked.
    return {};
  }
};

// `keepAlive`, for the reason `composerDraftAtom` in `@/state/ui` gives: the
// only subscribers are the terminal and toggle of the thread on screen, and
// both unmount while the next thread loads. A disposed node would come back
// with the map read at module load, hiding a drawer opened since, and the next
// toggle would write that stale map over every other thread's stored flag.
export const openByThreadAtom = Atom.keepAlive(
  Atom.make<Readonly<Record<string, true>>>(readOpenByThread()),
);

const persistOpen = (openByThread: Readonly<Record<string, true>>) => {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(openByThread));
  } catch {
    // localStorage can throw (private mode, quota); the atom still updates.
  }
};

/**
 * Opens or closes any owner's drawer by key, for a caller that acts on more
 * than one — the New task hand-over, which closes the project's and opens the
 * thread's.
 */
export const useSetDrawerOpen = () => {
  const setOpenByThread = useAtomSet(openByThreadAtom);
  return React.useCallback(
    (key: string, open: boolean) =>
      setOpenByThread((current) => {
        const next = withDrawerOpen(current, key, open);
        if (next !== current) {
          persistOpen(next);
        }
        return next;
      }),
    [setOpenByThread],
  );
};

/** `[open, setOpen]` for one owner's terminal drawer. */
export const useTerminalOpen = (threadId: string) => {
  const open = useAtomValue(
    openByThreadAtom,
    React.useCallback(
      (openByThread: Readonly<Record<string, true>>) => openByThread[threadId] === true,
      [threadId],
    ),
  );
  const setOpenByThread = useAtomSet(openByThreadAtom);
  const setOpen = React.useCallback(
    (update: boolean | ((open: boolean) => boolean)) =>
      setOpenByThread((current) => {
        const wanted = typeof update === "function" ? update(current[threadId] === true) : update;
        const next = withDrawerOpen(current, threadId, wanted);
        if (next !== current) {
          persistOpen(next);
        }
        return next;
      }),
    [setOpenByThread, threadId],
  );
  return [open, setOpen] as const;
};

const HEIGHT_KEY = "poseidon:terminal-height";
const HEIGHT_DEFAULT = 280;
export const DRAWER_HEIGHT_MIN = 120;
/** The drawer may take this share of the thread column, and no more. */
export const DRAWER_HEIGHT_MAX_FRACTION = 0.7;
/** The conversation above the drawer keeps at least this much of the column. */
export const TIMELINE_HEIGHT_MIN = 120;
/** Stands in for the drawer's bound before the column has been measured. */
const HEIGHT_MAX_FALLBACK = 1400;

/**
 * The tallest the drawer may be in a column `columnHeight` tall whose rows
 * that never shrink — the header, the composer — take `fixedHeight`: its share
 * of the column, and never so much that the conversation drops below
 * `TIMELINE_HEIGHT_MIN`, the way the dock always leaves the thread column its
 * `THREAD_COLUMN_MIN`.
 */
export const drawerHeightMax = (columnHeight: number, fixedHeight: number): number =>
  Math.round(
    Math.min(
      columnHeight * DRAWER_HEIGHT_MAX_FRACTION,
      columnHeight - fixedHeight - TIMELINE_HEIGHT_MIN,
    ),
  );

/**
 * Clamp to `[DRAWER_HEIGHT_MIN, max]`, with the minimum winning when a short
 * window inverts the two.
 */
export const clampDrawerHeight = (height: number, max: number): number =>
  Math.max(DRAWER_HEIGHT_MIN, Math.min(Math.round(max), Math.round(height)));

/** Absent or unparseable storage means the default height. */
export const parseDrawerHeight = (raw: string | null | undefined): number => {
  if (raw === null || raw === undefined) {
    return HEIGHT_DEFAULT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? clampDrawerHeight(parsed, HEIGHT_MAX_FALLBACK) : HEIGHT_DEFAULT;
};

const readDrawerHeight = (): number => {
  try {
    return parseDrawerHeight(globalThis.localStorage?.getItem(HEIGHT_KEY));
  } catch {
    return HEIGHT_DEFAULT;
  }
};

/**
 * Drawer height in px; mirrored to localStorage on every write. `keepAlive`
 * like the open map: its only subscriber is the open drawer, so closing it
 * would otherwise bring back the height read at module load.
 */
export const drawerHeightAtom = Atom.keepAlive(Atom.make<number>(readDrawerHeight()));

export const useDrawerHeight = () => {
  const height = useAtomValue(drawerHeightAtom);
  const setHeight = useAtomSet(drawerHeightAtom);
  const setPersistedHeight = React.useCallback(
    (next: number, max: number) => {
      const clamped = clampDrawerHeight(next, max);
      try {
        globalThis.localStorage?.setItem(HEIGHT_KEY, String(clamped));
      } catch {
        // localStorage can throw (private mode, quota); the atom still updates.
      }
      setHeight(clamped);
    },
    [setHeight],
  );
  return [height, setPersistedHeight] as const;
};
