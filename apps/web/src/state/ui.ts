/**
 * UI-only atoms — presentation state that never reaches the server.
 *
 * Row disclosure lives in a single override map keyed by itemId so expanding a
 * tool row survives virtualization (the row unmounts, the state does not).
 * Sidebar and dock widths, the start screen's per-project workspace mode,
 * each thread's last pull request link and the Changes pane's scope and diff
 * style persist through localStorage — durable layout and conveniences,
 * nothing more. The dock's per-thread memory does not: it lasts the session,
 * so a relaunch starts with every dock closed.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TurnReference } from "@poseidon/contracts/runtime";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import type { DockMemory } from "@/components/dock/dock-toggle";

/**
 * An atom for a choice persisted in localStorage, read once when this module
 * loads. `keepAlive`, because a plain atom is dropped when its last subscriber
 * unmounts, and the next mount starts again from that load-time value: a
 * choice made since would be lost on the next tab switch or route change, and
 * come back only after a reload.
 */
export const rememberedAtom = <A>(initial: A): Atom.Writable<A> =>
  Atom.keepAlive(Atom.make<A>(initial));

/** Per-row disclosure overrides: `itemId -> open`. Absent = the row's default. */
export const rowDisclosureAtom = Atom.make<Readonly<Record<string, boolean>>>({});

/**
 * `[open, setOpen]` for one disclosure, where `defaultOpen` covers rows that
 * start expanded (plan cards) against the collapsed default. `setOpen` takes
 * the explicit next state so it can be handed to `Collapsible.onOpenChange`.
 */
export const useRowDisclosure = (rowId: string, defaultOpen = false) => {
  const isOpen = useAtomValue(
    rowDisclosureAtom,
    React.useCallback((overrides) => overrides[rowId] ?? defaultOpen, [rowId, defaultOpen]),
  );
  const setOverrides = useAtomSet(rowDisclosureAtom);
  const setOpen = React.useCallback(
    (open: boolean) => setOverrides((overrides) => ({ ...overrides, [rowId]: open })),
    [setOverrides, rowId],
  );
  return [isOpen, setOpen] as const;
};

/**
 * Opens or closes many disclosures at once — `timeline.collapseAll` and
 * `expandAll` — by writing an override for each id, which beats every row's
 * own default the same way a click does.
 */
export const useSetRowDisclosures = () => {
  const setOverrides = useAtomSet(rowDisclosureAtom);
  return React.useCallback(
    (rowIds: ReadonlyArray<string>, open: boolean) =>
      setOverrides((overrides) => {
        const next = { ...overrides };
        for (const rowId of rowIds) {
          next[rowId] = open;
        }
        return next;
      }),
    [setOverrides],
  );
};

/** Clamp to `[min, max]`, with `min` winning when a narrow window inverts the two. */
const clampWidth = (width: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(width)));

const readStoredWidth = (key: string, fallback: number, min: number, max: number): number => {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (stored === null || stored === undefined) {
      return fallback;
    }
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? clampWidth(parsed, min, max) : fallback;
  } catch {
    return fallback;
  }
};

const writeStoredWidth = (key: string, width: number) => {
  try {
    globalThis.localStorage?.setItem(key, String(width));
  } catch {
    // localStorage can throw (private mode, quota); the atom still updates.
  }
};

const DOCK_WIDTH_KEY = "poseidon:dock-width";
const DOCK_WIDTH_DEFAULT = 480;
const DOCK_WIDTH_MIN = 280;
/**
 * The dock may take up to this share of the area beside the sidebar, and never
 * so much that the thread column drops below `THREAD_COLUMN_MIN`. The drag
 * passes that area's width in; CSS applies the same bounds, so a window shrunk
 * after the drag still leaves the thread column its room.
 */
export const DOCK_WIDTH_MAX_FRACTION = 0.8;
export const THREAD_COLUMN_MIN = 360;

const DOCK_WIDTH_MAX_FALLBACK = 1600;

/** Right-dock width in px; mirrored to localStorage on every write. */
const dockWidthAtom = rememberedAtom<number>(
  readStoredWidth(DOCK_WIDTH_KEY, DOCK_WIDTH_DEFAULT, DOCK_WIDTH_MIN, DOCK_WIDTH_MAX_FALLBACK),
);

/**
 * The widths the dock may take beside `available` px: its floor, and the
 * lesser of its share of the row and what leaves the thread column its room.
 * The floor wins when a narrow window inverts the two, as `clampWidth` does.
 */
export const dockWidthBounds = (available: number): { min: number; max: number } => ({
  min: DOCK_WIDTH_MIN,
  max: Math.max(
    DOCK_WIDTH_MIN,
    Math.round(Math.min(available * DOCK_WIDTH_MAX_FRACTION, available - THREAD_COLUMN_MIN)),
  ),
});

/**
 * `[width, setWidth, resetWidth]`: `setWidth` clamps to `dockWidthBounds` for
 * the `available` width it is given, and `resetWidth` puts back the default —
 * the resize edge's double-click.
 */
export const useDockWidth = () => {
  const width = useAtomValue(dockWidthAtom);
  const setWidth = useAtomSet(dockWidthAtom);
  const setPersistedWidth = React.useCallback(
    (next: number, available: number) => {
      const bounds = dockWidthBounds(available);
      const clamped = clampWidth(next, bounds.min, bounds.max);
      writeStoredWidth(DOCK_WIDTH_KEY, clamped);
      setWidth(clamped);
    },
    [setWidth],
  );
  const resetWidth = React.useCallback(() => {
    writeStoredWidth(DOCK_WIDTH_KEY, DOCK_WIDTH_DEFAULT);
    setWidth(DOCK_WIDTH_DEFAULT);
  }, [setWidth]);
  return [width, setPersistedWidth, resetWidth] as const;
};

const SIDEBAR_WIDTH_KEY = "poseidon:sidebar-width";
const SIDEBAR_WIDTH_DEFAULT = 260;
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 480;

/** Left-sidebar width in px; mirrored to localStorage on every write. */
const sidebarWidthAtom = rememberedAtom<number>(
  readStoredWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX),
);

export const useSidebarWidth = () => {
  const width = useAtomValue(sidebarWidthAtom);
  const setWidth = useAtomSet(sidebarWidthAtom);
  const setPersistedWidth = React.useCallback(
    (next: number) => {
      const clamped = clampWidth(next, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
      writeStoredWidth(SIDEBAR_WIDTH_KEY, clamped);
      setWidth(clamped);
    },
    [setWidth],
  );
  return [width, setPersistedWidth] as const;
};

/** Puts the sidebar and dock back at their default widths, for Appearance's reset. */
export const useResetLayoutWidths = () => {
  const setSidebarWidth = useAtomSet(sidebarWidthAtom);
  const setDockWidth = useAtomSet(dockWidthAtom);
  return React.useCallback(() => {
    writeStoredWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_DEFAULT);
    writeStoredWidth(DOCK_WIDTH_KEY, DOCK_WIDTH_DEFAULT);
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    setDockWidth(DOCK_WIDTH_DEFAULT);
  }, [setSidebarWidth, setDockWidth]);
};

/**
 * What is typed into a thread's composer but not sent yet: the text, the `#`
 * file mentions it names (workspace-relative paths, sent as `mentions`), the
 * skills and plugins picked from `@` and `$` (sent as `references`), and the
 * files staged against it.
 *
 * It used to be plain component state. The thread route is not remounted on a
 * param change, but the composer is rendered only while a snapshot exists, and
 * the next thread's `threadDetailAtom` starts at `Initial` — so clicking
 * another thread in the sidebar unmounted the composer and threw the draft
 * away. A long message, or a pasted screenshot, with no warning and nothing
 * sent or saved.
 *
 * Keyed by threadId, the way `useDockMemory` and `useRowDisclosure` are, and
 * in memory only: a `File` cannot be serialized, and a draft is not something
 * to resurrect across a relaunch without the attachments it named.
 */
export interface ComposerDraft {
  readonly text: string;
  readonly mentions: ReadonlyArray<string>;
  readonly references: ReadonlyArray<TurnReference>;
  readonly files: ReadonlyArray<File>;
}

export const emptyComposerDraft: ComposerDraft = {
  text: "",
  mentions: [],
  references: [],
  files: [],
};

const isEmptyDraft = (draft: ComposerDraft): boolean =>
  draft.text === "" &&
  draft.mentions.length === 0 &&
  draft.references.length === 0 &&
  draft.files.length === 0;

/**
 * The map with one thread's draft replaced. An emptied draft drops its key
 * rather than leaving `{ text: "", … }` behind for every thread ever opened.
 */
export const withComposerDraft = (
  drafts: Readonly<Record<string, ComposerDraft>>,
  threadId: string,
  draft: ComposerDraft,
): Readonly<Record<string, ComposerDraft>> => {
  if (isEmptyDraft(draft)) {
    if (!(threadId in drafts)) {
      return drafts;
    }
    const next = { ...drafts };
    delete next[threadId];
    return next;
  }
  return { ...drafts, [threadId]: draft };
};

// `keepAlive`, and it is the whole point: an atom is disposed when its last
// subscriber goes, and the only subscriber here is the composer of the thread
// being looked at. Without it the map is thrown away by the very unmount it
// exists to survive, and the draft is gone exactly as before.
const composerDraftAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, ComposerDraft>>>({}));

export interface ComposerDraftHandle extends ComposerDraft {
  readonly setText: React.Dispatch<React.SetStateAction<string>>;
  readonly setMentions: React.Dispatch<React.SetStateAction<ReadonlyArray<string>>>;
  readonly setReferences: React.Dispatch<React.SetStateAction<ReadonlyArray<TurnReference>>>;
  readonly setFiles: React.Dispatch<React.SetStateAction<ReadonlyArray<File>>>;
}

const applyUpdate = <A>(update: React.SetStateAction<A>, current: A): A =>
  typeof update === "function" ? (update as (value: A) => A)(current) : update;

/** One thread's draft, with `useState`-shaped setters for each of its parts. */
export const useComposerDraft = (threadId: string): ComposerDraftHandle => {
  const draft = useAtomValue(
    composerDraftAtom,
    React.useCallback(
      (drafts: Readonly<Record<string, ComposerDraft>>) => drafts[threadId] ?? emptyComposerDraft,
      [threadId],
    ),
  );
  const setDrafts = useAtomSet(composerDraftAtom);
  const patch = React.useCallback(
    (change: (current: ComposerDraft) => ComposerDraft) =>
      setDrafts((drafts) =>
        withComposerDraft(drafts, threadId, change(drafts[threadId] ?? emptyComposerDraft)),
      ),
    [setDrafts, threadId],
  );
  return {
    ...draft,
    setText: React.useCallback(
      (update) => patch((current) => ({ ...current, text: applyUpdate(update, current.text) })),
      [patch],
    ),
    setMentions: React.useCallback(
      (update) =>
        patch((current) => ({ ...current, mentions: applyUpdate(update, current.mentions) })),
      [patch],
    ),
    setReferences: React.useCallback(
      (update) =>
        patch((current) => ({ ...current, references: applyUpdate(update, current.references) })),
      [patch],
    ),
    setFiles: React.useCallback(
      (update) => patch((current) => ({ ...current, files: applyUpdate(update, current.files) })),
      [patch],
    ),
  };
};

/**
 * Where an earlier build kept each thread's dock tab, so every thread came back
 * with its dock open after a relaunch. The dock now starts closed and its
 * memory lasts one session; the stale map is dropped once, as this loads.
 */
const LEGACY_DOCK_TAB_KEY = "poseidon:dock-tab-by-thread";

try {
  globalThis.localStorage?.removeItem(LEGACY_DOCK_TAB_KEY);
} catch {
  // Blocked storage has nothing to clear.
}

/** A thread's dock memory with `memory` replaced; an empty one drops its key. */
export const withDockMemory = (
  memories: Readonly<Record<string, DockMemory>>,
  threadId: string,
  memory: DockMemory | undefined,
): Readonly<Record<string, DockMemory>> => {
  if (memory === memories[threadId]) {
    return memories;
  }
  if (
    memory === undefined ||
    (memory.shown === undefined &&
      memory.lastTab === undefined &&
      (memory.openTabs ?? []).length === 0)
  ) {
    if (!(threadId in memories)) {
      return memories;
    }
    const next = { ...memories };
    delete next[threadId];
    return next;
  }
  return { ...memories, [threadId]: memory };
};

// In memory only, and `keepAlive` so switching threads (which unmounts the
// only reader) does not throw the map away: the dock is meant to come back as
// each thread left it for the rest of the session, and closed after a
// relaunch.
const dockMemoryAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, DockMemory>>>({}));

/**
 * One thread's dock memory (`DockMemory`, from the dock's pure half) and an
 * updater that runs one of that module's steps against it.
 */
export const useDockMemory = (threadId: string) => {
  const memory = useAtomValue(
    dockMemoryAtom,
    React.useCallback(
      (memories: Readonly<Record<string, DockMemory>>) => memories[threadId],
      [threadId],
    ),
  );
  const setMemories = useAtomSet(dockMemoryAtom);
  const update = React.useCallback(
    (step: (current: DockMemory | undefined) => DockMemory | undefined) =>
      setMemories((memories) => withDockMemory(memories, threadId, step(memories[threadId]))),
    [setMemories, threadId],
  );
  return [memory, update] as const;
};

const LAST_PROJECT_KEY = "poseidon:last-project";

const readLastProject = (): string | null => {
  try {
    return globalThis.localStorage?.getItem(LAST_PROJECT_KEY) ?? null;
  } catch {
    return null;
  }
};

/**
 * The project a thread was last started in — what the home composer's picker
 * opens on. Persisted so a relaunch lands on the same project. Kept as a plain
 * string; the caller checks it still names a project before using it.
 */
const lastProjectAtom = Atom.make<string | null>(readLastProject());

export const useLastProject = () => {
  const lastProject = useAtomValue(lastProjectAtom);
  const setLastProject = useAtomSet(lastProjectAtom);
  const remember = React.useCallback(
    (projectId: string) => {
      try {
        globalThis.localStorage?.setItem(LAST_PROJECT_KEY, projectId);
      } catch {
        // localStorage can throw (private mode, quota); the atom still updates.
      }
      setLastProject(projectId);
    },
    [setLastProject],
  );
  return [lastProject, remember] as const;
};

const COLLAPSED_PROJECTS_KEY = "poseidon:collapsed-projects";

/** Absent, unparseable or foreign-shaped storage all mean "nothing collapsed". */
export const parseCollapsedProjects = (raw: string | null | undefined): ReadonlySet<string> => {
  if (raw === null || raw === undefined) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((entry): entry is string => typeof entry === "string"))
      : new Set();
  } catch {
    return new Set();
  }
};

const readCollapsedProjects = (): ReadonlySet<string> => {
  try {
    return parseCollapsedProjects(globalThis.localStorage?.getItem(COLLAPSED_PROJECTS_KEY));
  } catch {
    return new Set();
  }
};

/**
 * Sidebar projects whose thread list is folded away. Stored as the collapsed
 * set rather than the expanded one, so a newly added project starts open.
 * Persisted: a folded sidebar is layout, and should survive a relaunch.
 */
const collapsedProjectsAtom = Atom.make<ReadonlySet<string>>(readCollapsedProjects());

/** Every folded project, for the tree and the thread keys that walk its order. */
export const useCollapsedProjects = (): ReadonlySet<string> => useAtomValue(collapsedProjectsAtom);

/** `[collapsed, setCollapsed]` for one project's section in the sidebar. */
export const useProjectCollapsed = (projectId: string) => {
  const collapsed = useAtomValue(
    collapsedProjectsAtom,
    React.useCallback((ids: ReadonlySet<string>) => ids.has(projectId), [projectId]),
  );
  const setIds = useAtomSet(collapsedProjectsAtom);
  const setCollapsed = React.useCallback(
    (next: boolean) =>
      setIds((current) => {
        if (current.has(projectId) === next) {
          return current;
        }
        const ids = new Set(current);
        if (next) {
          ids.add(projectId);
        } else {
          ids.delete(projectId);
        }
        try {
          globalThis.localStorage?.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...ids]));
        } catch {
          // localStorage can throw (private mode, quota); the atom still updates.
        }
        return ids;
      }),
    [setIds, projectId],
  );
  return [collapsed, setCollapsed] as const;
};

/** Where the start screen runs a new thread: the project's own folder, or a new worktree. */
export type WorkspaceMode = "local" | "worktree";

const WORKSPACE_MODES_KEY = "poseidon:workspace-modes";

/** Absent, unparseable or foreign-shaped storage all mean "local everywhere". */
export const parseWorkspaceModes = (
  raw: string | null | undefined,
): Readonly<Record<string, WorkspaceMode>> => {
  if (raw === null || raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const modes: Record<string, WorkspaceMode> = {};
    for (const [projectId, mode] of Object.entries(parsed)) {
      if (mode === "worktree") {
        modes[projectId] = mode;
      }
    }
    return modes;
  } catch {
    return {};
  }
};

/**
 * The map with one project's mode set. Local is the default, so it is stored
 * as the key's absence and a project that goes back to local drops out.
 */
export const withWorkspaceMode = (
  modes: Readonly<Record<string, WorkspaceMode>>,
  projectId: string,
  mode: WorkspaceMode,
): Readonly<Record<string, WorkspaceMode>> => {
  if ((modes[projectId] ?? "local") === mode) {
    return modes;
  }
  const next = { ...modes };
  if (mode === "local") {
    delete next[projectId];
  } else {
    next[projectId] = mode;
  }
  return next;
};

const readWorkspaceModes = (): Readonly<Record<string, WorkspaceMode>> => {
  try {
    return parseWorkspaceModes(globalThis.localStorage?.getItem(WORKSPACE_MODES_KEY));
  } catch {
    return {};
  }
};

/**
 * The mode each project's last thread was started in, so the start screen
 * opens on it again. Persisted: someone who works in worktrees on one project
 * should not have to pick it every time.
 */
const workspaceModesAtom =
  rememberedAtom<Readonly<Record<string, WorkspaceMode>>>(readWorkspaceModes());

/** `[mode, setMode]` for one project on the start screen. */
export const useWorkspaceMode = (projectId: string) => {
  const mode = useAtomValue(
    workspaceModesAtom,
    React.useCallback(
      (modes: Readonly<Record<string, WorkspaceMode>>) => modes[projectId] ?? "local",
      [projectId],
    ),
  );
  const setModes = useAtomSet(workspaceModesAtom);
  const setMode = React.useCallback(
    (next: WorkspaceMode) =>
      setModes((current) => {
        const modes = withWorkspaceMode(current, projectId, next);
        if (modes !== current) {
          try {
            globalThis.localStorage?.setItem(WORKSPACE_MODES_KEY, JSON.stringify(modes));
          } catch {
            // localStorage can throw (private mode, quota); the atom still updates.
          }
        }
        return modes;
      }),
    [setModes, projectId],
  );
  return [mode, setMode] as const;
};

const PULL_REQUESTS_KEY = "poseidon:pull-requests-by-thread";

/** Only a web link is kept: the URL is opened in the system browser later. */
const isWebUrl = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** Absent, unparseable or foreign-shaped storage all mean "no pull requests yet". */
export const parsePullRequestLinks = (
  raw: string | null | undefined,
): Readonly<Record<string, string>> => {
  if (raw === null || raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => isWebUrl(entry[1])),
    );
  } catch {
    return {};
  }
};

/** The map with one key's link set; a link that is not a web URL changes nothing. */
export const withPullRequestLink = (
  links: Readonly<Record<string, string>>,
  key: string,
  url: string,
): Readonly<Record<string, string>> =>
  links[key] === url || !isWebUrl(url) ? links : { ...links, [key]: url };

/**
 * Where a pull request link is kept: one workspace (`workspaceKey`) on one
 * branch, so a thread that moves to another branch does not show the old
 * branch's pull request. `null` on a detached HEAD, where nothing is kept.
 * Links stored before this, keyed by the workspace alone, are never read.
 */
export const pullRequestLinkKey = (workspace: string, branch: string | null): string | null =>
  branch === null ? null : `${workspace}#${branch}`;

const readPullRequestLinks = (): Readonly<Record<string, string>> => {
  try {
    return parsePullRequestLinks(globalThis.localStorage?.getItem(PULL_REQUESTS_KEY));
  } catch {
    return {};
  }
};

/**
 * The last pull request the git actions control opened (or found open) for
 * each branch of each thread — or project folder, `project:<id>`, for the New
 * task page's control — kept across reloads (`pullRequestLinkKey`). The
 * header's View PR button reads it back. The server keeps no record of it,
 * and a cleared store loses nothing else.
 */
const pullRequestLinksAtom =
  rememberedAtom<Readonly<Record<string, string>>>(readPullRequestLinks());

/**
 * `[url, remember]` for one `pullRequestLinkKey`; `url` is `null` until a
 * pull request is known, and always on a `null` key. `remember` stores under
 * `at` (the hook's key by default) and does nothing for a `null` one.
 */
export const usePullRequestLink = (key: string | null) => {
  const url = useAtomValue(
    pullRequestLinksAtom,
    React.useCallback(
      (links: Readonly<Record<string, string>>) => (key === null ? null : (links[key] ?? null)),
      [key],
    ),
  );
  const setLinks = useAtomSet(pullRequestLinksAtom);
  const remember = React.useCallback(
    (next: string, at: string | null = key) =>
      setLinks((current) => {
        if (at === null) {
          return current;
        }
        const links = withPullRequestLink(current, at, next);
        if (links !== current) {
          try {
            globalThis.localStorage?.setItem(PULL_REQUESTS_KEY, JSON.stringify(links));
          } catch {
            // localStorage can throw (private mode, quota); the atom still updates.
          }
        }
        return links;
      }),
    [setLinks, key],
  );
  return [url, remember] as const;
};

/**
 * One remembered choice out of a fixed set, stored as the plain string. A
 * stored value outside the set — written by an older build, or by hand —
 * reads as the default rather than as a choice the UI cannot show.
 */
const parseChoice =
  <A extends string>(choices: ReadonlyArray<A>, fallback: A) =>
  (raw: string | null | undefined): A =>
    choices.find((choice) => choice === raw) ?? fallback;

const readChoice = <A extends string>(key: string, parse: (raw: string | null) => A): A => {
  try {
    return parse(globalThis.localStorage?.getItem(key) ?? null);
  } catch {
    return parse(null);
  }
};

/** `[value, remember]` over a choice's atom, mirroring each write to localStorage. */
const useRememberedChoice = <A extends string>(atom: Atom.Writable<A>, key: string) => {
  const value = useAtomValue(atom);
  const setValue = useAtomSet(atom);
  const remember = React.useCallback(
    (next: A) => {
      try {
        globalThis.localStorage?.setItem(key, next);
      } catch {
        // localStorage can throw (private mode, quota); the atom still updates.
      }
      setValue(next);
    },
    [setValue, key],
  );
  return [value, remember] as const;
};

/**
 * What the Changes pane compares: this turn's checkpoints (the turn selector),
 * the branch against its base, or the uncommitted working tree.
 */
export type ChangesScope = "turn" | "branch" | "uncommitted";

/** Absent or unknown storage means "This turn", what the pane has always opened on. */
export const parseChangesScope = parseChoice<ChangesScope>(
  ["turn", "branch", "uncommitted"],
  "turn",
);

/** How a patch is laid out: one column, or old and new side by side. */
export type DiffStyle = "unified" | "split";

/** Absent or unknown storage means unified, the layout the timeline uses. */
export const parseDiffStyle = parseChoice<DiffStyle>(["unified", "split"], "unified");

const CHANGES_SCOPE_KEY = "poseidon:changes-scope";
const DIFF_STYLE_KEY = "poseidon:diff-style";

const changesScopeAtom = rememberedAtom<ChangesScope>(
  readChoice(CHANGES_SCOPE_KEY, parseChangesScope),
);
const diffStyleAtom = rememberedAtom<DiffStyle>(readChoice(DIFF_STYLE_KEY, parseDiffStyle));

/**
 * `[scope, setScope]` for the Changes pane. One choice for every thread: it is
 * how someone likes to review, not a property of the thread.
 */
export const useChangesScope = () => useRememberedChoice(changesScopeAtom, CHANGES_SCOPE_KEY);

/** `[style, setStyle]` for the Changes pane's diffs; timeline rows stay unified. */
export const useDiffStyle = () => useRememberedChoice(diffStyleAtom, DIFF_STYLE_KEY);

/**
 * Where one thread's review of its changes stands, per file path: which files
 * the user opened or closed in the Changes pane, and which they marked viewed.
 *
 * Keyed by path, not by comparison, so the choice follows the file: a new turn
 * or another pick in the Compare menu does not throw every file open again,
 * and a file whose patch moved keeps the state it was left in. `viewed` holds
 * the patch hash each mark was made against rather than a flag — a patch that
 * changes since reads as not viewed, with nothing to reset. A path absent from
 * `open` takes the list's default (`startsOpen` in the pane).
 */
export interface ChangesReview {
  readonly open: Readonly<Record<string, boolean>>;
  readonly viewed: Readonly<Record<string, string>>;
}

export const emptyChangesReview: ChangesReview = { open: {}, viewed: {} };

// In memory only, like the composer draft: a review is a working session, not
// layout. `keepAlive`, because the pane that reads it unmounts every time the
// dock closes or switches tab, and the review has to outlive that.
const changesReviewAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, ChangesReview>>>({}));

/** `[review, update]` for one thread; `update` maps the thread's review to its next one. */
export const useChangesReview = (threadId: string) => {
  const review = useAtomValue(
    changesReviewAtom,
    React.useCallback(
      (reviews: Readonly<Record<string, ChangesReview>>) => reviews[threadId] ?? emptyChangesReview,
      [threadId],
    ),
  );
  const setReviews = useAtomSet(changesReviewAtom);
  const update = React.useCallback(
    (change: (current: ChangesReview) => ChangesReview) =>
      setReviews((reviews) => ({
        ...reviews,
        [threadId]: change(reviews[threadId] ?? emptyChangesReview),
      })),
    [setReviews, threadId],
  );
  return [review, update] as const;
};
