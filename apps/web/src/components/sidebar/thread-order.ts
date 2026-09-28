/**
 * The order the sidebar lists threads in, as data.
 *
 * The tree draws it and the thread keys walk it: `Mod+1`…`Mod+9` open the Nth
 * row and `Mod+Shift+[` / `Mod+Shift+]` step to the row above or below. Both
 * derive from `sidebarThreadGroups` here, so the Nth thread a key opens is the
 * Nth row on screen and the two cannot drift apart.
 *
 * The rule: pinned threads first, newest pin first (`./thread-pins`); then
 * projects in their listed order, each with its threads in list order — a
 * folded project contributes only the open thread, which the tree keeps
 * showing under it — then the threads whose project is gone ("Other
 * threads"). A pinned thread is listed in the pinned group only, so no row
 * appears twice, and folding its project does not hide it. Archived threads
 * are left out except the open one, by `sidebarThreads`, pinned or not.
 *
 * Within a project, the threads `isDone` picks (`./thread-done`) follow the
 * active ones in the project's "Done" section, and only while that section is
 * expanded — a collapsed one keeps just the open thread, as a folded project
 * does. A folded project hides its Done section with the rest.
 */

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { sidebarThreads } from "@/components/sidebar/visible-threads";

interface OrderedThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly status: ThreadSummary["status"];
}

export interface SidebarThreadGroups<T> {
  /** Listed threads that are pinned, in pin order; in no other group. */
  readonly pinned: ReadonlyArray<T>;
  /** Each known project's listed threads, folding already applied. */
  readonly byProject: ReadonlyMap<string, ReadonlyArray<T>>;
  /** Listed threads whose project is not in the project list. */
  readonly orphans: ReadonlyArray<T>;
  /** Each project's listed Done threads: the open one only, while collapsed. */
  readonly doneByProject: ReadonlyMap<string, ReadonlyArray<T>>;
  /** How many threads each unfolded project's Done section holds. */
  readonly doneCount: ReadonlyMap<string, number>;
}

export interface SidebarOrderOptions<T> {
  /** Pinned thread ids, newest pin first — see `./thread-pins`. */
  readonly pinned?: ReadonlyArray<string>;
  /** Which threads belong in their project's Done section; none without it. */
  readonly isDone?: (thread: T) => boolean;
  /** Projects whose Done section is expanded. */
  readonly doneExpanded?: ReadonlySet<string>;
}

const append = <K, V>(map: Map<K, Array<V>>, key: K, value: V) => {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
};

/** The sidebar's rows, grouped the way the tree draws them. */
export const sidebarThreadGroups = <T extends OrderedThread>(
  projects: ReadonlyArray<{ readonly projectId: string }>,
  threads: ReadonlyArray<T>,
  collapsed: ReadonlySet<string>,
  openThreadId: string | null,
  options: SidebarOrderOptions<T> = {},
): SidebarThreadGroups<T> => {
  const known = new Set(projects.map((project) => project.projectId));
  const pinRank = new Map((options.pinned ?? []).map((threadId, rank) => [threadId, rank]));
  const pinned: Array<T> = [];
  const byProject = new Map<string, Array<T>>();
  const orphans: Array<T> = [];
  const doneByProject = new Map<string, Array<T>>();
  const doneCount = new Map<string, number>();
  for (const thread of sidebarThreads(threads, openThreadId)) {
    if (pinRank.has(thread.threadId)) {
      pinned.push(thread);
      continue;
    }
    if (!known.has(thread.projectId)) {
      orphans.push(thread);
      continue;
    }
    const open = thread.threadId === openThreadId;
    if (collapsed.has(thread.projectId)) {
      if (open) {
        append(byProject, thread.projectId, thread);
      }
      continue;
    }
    if (options.isDone?.(thread) === true) {
      doneCount.set(thread.projectId, (doneCount.get(thread.projectId) ?? 0) + 1);
      if (open || options.doneExpanded?.has(thread.projectId) === true) {
        append(doneByProject, thread.projectId, thread);
      }
      continue;
    }
    append(byProject, thread.projectId, thread);
  }
  pinned.sort((a, b) => pinRank.get(a.threadId)! - pinRank.get(b.threadId)!);
  return { pinned, byProject, orphans, doneByProject, doneCount };
};

/** The groups' rows top to bottom: what the tree draws and the keys walk. */
export const groupedThreadOrder = <T>(
  projects: ReadonlyArray<{ readonly projectId: string }>,
  groups: Pick<SidebarThreadGroups<T>, "pinned" | "byProject" | "orphans" | "doneByProject">,
): ReadonlyArray<T> => [
  ...groups.pinned,
  ...projects.flatMap((project) => [
    ...(groups.byProject.get(project.projectId) ?? []),
    ...(groups.doneByProject.get(project.projectId) ?? []),
  ]),
  ...groups.orphans,
];

/** Every thread row in the sidebar, top to bottom. */
export const sidebarThreadOrder = <T extends OrderedThread>(
  projects: ReadonlyArray<{ readonly projectId: string }>,
  threads: ReadonlyArray<T>,
  collapsed: ReadonlySet<string>,
  openThreadId: string | null,
  options: SidebarOrderOptions<T> = {},
): ReadonlyArray<T> =>
  groupedThreadOrder(
    projects,
    sidebarThreadGroups(projects, threads, collapsed, openThreadId, options),
  );

/** The Nth row (1-based), or `undefined` past the end — `Mod+9` on a short list. */
export const nthThread = <T>(order: ReadonlyArray<T>, n: number): T | undefined =>
  Number.isInteger(n) && n >= 1 ? order[n - 1] : undefined;

/**
 * The row `step` away from the open thread, wrapping at both ends. With no
 * open thread (or one the sidebar does not list) the first step lands on the
 * first row going down and the last row going up.
 */
export const neighbourThread = <T extends { readonly threadId: string }>(
  order: ReadonlyArray<T>,
  openThreadId: string | null,
  step: 1 | -1,
): T | undefined => {
  if (order.length === 0) {
    return undefined;
  }
  const at = openThreadId === null ? -1 : order.findIndex((t) => t.threadId === openThreadId);
  if (at === -1) {
    return step === 1 ? order[0] : order[order.length - 1];
  }
  return order[(at + step + order.length) % order.length];
};

/**
 * Where "new thread in this project" starts one: the open thread's project,
 * else the project a thread was last started in, else the first listed — each
 * only while it is still in the project list. `undefined` with no projects.
 */
export const projectForNewThread = <P extends { readonly projectId: string }>(
  projects: ReadonlyArray<P>,
  openThreadProjectId: string | undefined,
  lastProjectId: string | null,
): P | undefined =>
  projects.find((project) => project.projectId === openThreadProjectId) ??
  projects.find((project) => project.projectId === lastProjectId) ??
  projects[0];
