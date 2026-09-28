/**
 * What the thread keys act on, read once for every surface that names them:
 * the sidebar's thread order (so `Mod+N` opens the Nth row on screen, title
 * filter applied), the open thread, and the project `thread.newInProject`
 * starts a thread in.
 * `AppShortcuts` answers the keys from it and the palette labels its rows
 * from it, so the two can never disagree about which thread is number 3.
 */

import { useMatchRoute } from "@tanstack/react-router";
import * as React from "react";

import type { ProjectSummary, ThreadSummary } from "@poseidon/contracts/orchestration";

import { projectForNewThread, sidebarThreadOrder } from "@/components/sidebar/thread-order";
import { useThreadFilter } from "@/components/sidebar/thread-filter";
import { useThreadPins } from "@/components/sidebar/thread-pins";
import { useProjects, useThreadList } from "@/state/hooks";
import { useCollapsedProjects, useLastProject } from "@/state/ui";

export interface ThreadTargets {
  /** Every thread row in the sidebar, top to bottom. */
  readonly order: ReadonlyArray<ThreadSummary>;
  readonly openThreadId: string | null;
  /** Where `thread.newInProject` starts a thread; none without projects. */
  readonly newThreadProject: ProjectSummary | undefined;
}

export function useThreadTargets(): ThreadTargets {
  const projects = useProjects();
  const threads = useThreadList();
  const collapsed = useCollapsedProjects();
  const [lastProject] = useLastProject();
  const [pinned] = useThreadPins();
  const [query] = useThreadFilter();
  const openRoute = useMatchRoute()({ to: "/t/$threadId" });
  const openThreadId = openRoute === false ? null : openRoute.threadId;

  const order = React.useMemo(
    () => sidebarThreadOrder(projects, threads, collapsed, openThreadId, { pinned, query }),
    [projects, threads, collapsed, openThreadId, pinned, query],
  );
  const openThreadProject = threads.find((thread) => thread.threadId === openThreadId)?.projectId;
  const newThreadProject = projectForNewThread(projects, openThreadProject, lastProject);
  return { order, openThreadId, newThreadProject };
}
