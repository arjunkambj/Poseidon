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
 * A title filter (`./thread-filter`) narrows every group to the matching
 * threads and ignores folding, so a folded project still shows its matches;
 * the open thread is not exempt, and an archived one is still listed only
 * while it is open.
 */

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { isFiltering, matchesTitle } from "@/components/sidebar/thread-filter";
import { sidebarThreads } from "@/components/sidebar/visible-threads";

interface OrderedThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly status: ThreadSummary["status"];
  /** Read only by the title filter. */
  readonly title?: string;
}

export interface SidebarThreadGroups<T> {
  /** Listed threads that are pinned, in pin order; in no other group. */
  readonly pinned: ReadonlyArray<T>;
  /** Each known project's listed threads, folding already applied. */
  readonly byProject: ReadonlyMap<string, ReadonlyArray<T>>;
  /** Listed threads whose project is not in the project list. */
  readonly orphans: ReadonlyArray<T>;
}

export interface SidebarOrderOptions {
  /** Pinned thread ids, newest pin first — see `./thread-pins`. */
  readonly pinned?: ReadonlyArray<string>;
  /** The title filter; blank lists everything — see `./thread-filter`. */
  readonly query?: string;
}

/** The sidebar's rows, grouped the way the tree draws them. */
export const sidebarThreadGroups = <T extends OrderedThread>(
  projects: ReadonlyArray<{ readonly projectId: string }>,
  threads: ReadonlyArray<T>,
  collapsed: ReadonlySet<string>,
  openThreadId: string | null,
  options: SidebarOrderOptions = {},
): SidebarThreadGroups<T> => {
  const known = new Set(projects.map((project) => project.projectId));
  const pinRank = new Map((options.pinned ?? []).map((threadId, rank) => [threadId, rank]));
  const pinned: Array<T> = [];
  const byProject = new Map<string, Array<T>>();
  const orphans: Array<T> = [];
  const query = options.query ?? "";
  const filtering = isFiltering(query);
  for (const thread of sidebarThreads(threads, openThreadId)) {
    if (filtering && !matchesTitle(thread.title ?? "", query)) {
      continue;
    }
    if (pinRank.has(thread.threadId)) {
      pinned.push(thread);
      continue;
    }
    if (!known.has(thread.projectId)) {
      orphans.push(thread);
      continue;
    }
    if (!filtering && collapsed.has(thread.projectId) && thread.threadId !== openThreadId) {
      continue;
    }
    const list = byProject.get(thread.projectId) ?? [];
    list.push(thread);
    byProject.set(thread.projectId, list);
  }
  pinned.sort((a, b) => pinRank.get(a.threadId)! - pinRank.get(b.threadId)!);
  return { pinned, byProject, orphans };
};

/** Every thread row in the sidebar, top to bottom. */
export const sidebarThreadOrder = <T extends OrderedThread>(
  projects: ReadonlyArray<{ readonly projectId: string }>,
  threads: ReadonlyArray<T>,
  collapsed: ReadonlySet<string>,
  openThreadId: string | null,
  options: SidebarOrderOptions = {},
): ReadonlyArray<T> => {
  const { pinned, byProject, orphans } = sidebarThreadGroups(
    projects,
    threads,
    collapsed,
    openThreadId,
    options,
  );
  return [
    ...pinned,
    ...projects.flatMap((project) => byProject.get(project.projectId) ?? []),
    ...orphans,
  ];
};

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
