/**
 * The projects → threads tree: projects from `projectsAtom`, threads from
 * `threadListAtom(null)` grouped client-side by `projectId` in
 * `./thread-order`, the same order the thread keys walk. Each thread row
 * links to `/t/$threadId` with a status slot, the title and a relative time —
 * see `./thread-row`. Anything waiting on the user outranks a turn in flight
 * and gets the icon and label together — see `./thread-status`.
 *
 * A row also carries the unread dot: the open thread stamps its `updatedAt`
 * into `thread-seen`, and any other thread that has moved past its own stamp
 * — or was marked unread from its menu — is marked. That is renderer state by
 * design — see `./thread-seen`.
 *
 * Pinned threads leave their project for a "Pinned" group above the tree
 * (`./pinned-threads`), first in the order the thread keys walk too. Pins are
 * this window's, like the unread stamps — see `./thread-pins`.
 *
 * The field in the Projects header filters every row by title
 * (`./thread-filter-input`); while it holds a query, projects with no match
 * and an empty "Other threads" are left out, and folding is ignored.
 *
 * The tree owns the one-minute tick behind every row's relative time, so a
 * long list runs one interval rather than one per row.
 *
 * A project row folds its threads away on click; the folded set persists
 * through `useProjectCollapsed`. It also counts the shells still running in
 * the project's own folder, when there are any (`ProjectTerminalsBadge`). The open thread stays listed under a folded
 * project, so the sidebar never loses track of where you are. A folded header
 * shows the most urgent status among the threads it hides — see
 * `./project-status`.
 *
 * Archived threads are not listed: they live on Settings → Archived threads.
 * The one exception is the thread that is open, which stays in place and looks
 * archived, for the same reason and because its menu carries Unarchive — see
 * `./visible-threads`.
 *
 * Cmd/Ctrl-click and Shift-click pick several thread rows; the picked ones
 * can be archived, marked unread or deleted together from the bar under the
 * tree — see `./thread-selection` and `./thread-selection-bar`.
 *
 * Every row has an overflow menu, revealed on hover: for a thread, rename,
 * pin, mark unread, copy, open a terminal, start a thread beside it, archive
 * and delete (`./thread-menu-items`); for a project, remove. A thread row also
 * offers archive on its own.
 * Those four commands existed end to end — decider, reactors, tests — with
 * nothing in the UI that could send them, so the sidebar only ever grew and a
 * mistyped project root could not be dropped.
 */

import { useMatchRoute } from "@tanstack/react-router";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@poseidon/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { ProjectId } from "@poseidon/contracts/ids";
import type { ProjectSummary, ThreadSummary } from "@poseidon/contracts/orchestration";

import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import { PinnedThreads } from "@/components/sidebar/pinned-threads";
import { ProjectTerminalsBadge } from "@/components/terminal/project-terminals-badge";
import { ProjectRowMenu } from "@/components/sidebar/project-menu";
import { projectStatusRollup, type ProjectStatusRollup } from "@/components/sidebar/project-status";
import { ProjectStatusMark } from "@/components/sidebar/project-status-mark";
import { isFiltering, useThreadFilter } from "@/components/sidebar/thread-filter";
import { ThreadFilterInput } from "@/components/sidebar/thread-filter-input";
import { ThreadRow } from "@/components/sidebar/thread-row";
import { sidebarThreadGroups } from "@/components/sidebar/thread-order";
import { useThreadPins } from "@/components/sidebar/thread-pins";
import { selectedRows } from "@/components/sidebar/thread-selection";
import { ThreadSelectionBar } from "@/components/sidebar/thread-selection-bar";
import {
  useThreadSelection,
  type ThreadSelectionControls,
} from "@/components/sidebar/use-thread-selection";
import { useCreateThread } from "@/lib/use-create-thread";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useConnectionState, useProjects, useThreadList } from "@/state/hooks";
import { useCollapsedProjects, useProjectCollapsed } from "@/state/ui";
import { Add, ChevronRight, Folder, FolderAdd, FolderOpen, Search } from "@honeyicons/react";

function NewThreadButton({
  projectId,
  onCreated,
}: {
  projectId: ProjectId;
  onCreated: () => void;
}) {
  const connection = useConnectionState();
  const { create, pending } = useCreateThread();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="New thread"
            disabled={pending || connection.status !== "connected"}
            onClick={() => {
              void create(projectId).then((accepted) => {
                if (accepted) {
                  onCreated();
                }
              });
            }}
          />
        }
      >
        <Add variant="bold" />
      </TooltipTrigger>
      <TooltipContent>New thread</TooltipContent>
    </Tooltip>
  );
}

/** A project's threads, archived ones included, and how many have a worktree. */
interface ThreadCounts {
  readonly threads: number;
  readonly worktrees: number;
}

const NO_THREADS: ThreadCounts = { threads: 0, worktrees: 0 };

export function ProjectTree() {
  const projects = useProjects();
  const threads = useThreadList();
  const connection = useConnectionState();
  const now = useNow(60_000);
  const openRoute = useMatchRoute()({ to: "/t/$threadId" });
  const openThreadId = openRoute === false ? null : openRoute.threadId;
  const collapsed = useCollapsedProjects();
  const [pins] = useThreadPins();
  const [query] = useThreadFilter();
  const filtering = isFiltering(query);
  // The same grouping the thread keys walk — see `./thread-order`.
  const {
    pinned: pinnedThreads,
    byProject: threadsByProject,
    orphans: orphanThreads,
  } = React.useMemo(
    () => sidebarThreadGroups(projects, threads, collapsed, openThreadId, { pinned: pins, query }),
    [projects, threads, collapsed, openThreadId, pins, query],
  );
  // Rows top to bottom, as `sidebarThreadOrder` walks them.
  const order = React.useMemo(
    () => [
      ...pinnedThreads,
      ...projects.flatMap((project) => threadsByProject.get(project.projectId) ?? []),
      ...orphanThreads,
    ],
    [pinnedThreads, projects, threadsByProject, orphanThreads],
  );
  // While filtering, a project with no matching thread is left out.
  const shownProjects = filtering
    ? projects.filter((project) => threadsByProject.has(project.projectId))
    : projects;
  const selection = useThreadSelection(order, openThreadId);
  // What each project would show folded, over all its threads, not the listed ones.
  const rollups = React.useMemo(() => {
    const byProject = Map.groupBy(threads, (thread) => thread.projectId);
    return new Map(
      [...byProject].map(([id, list]) => [id, projectStatusRollup(list, openThreadId)]),
    );
  }, [threads, openThreadId]);
  // Removing a project deletes its archived threads too, so the removal copy
  // counts every thread, not only the listed ones — and the worktrees among
  // them, which it leaves on disk.
  const threadCounts = React.useMemo(() => {
    const counts = new Map<ProjectId, ThreadCounts>();
    for (const thread of threads) {
      const current = counts.get(thread.projectId) ?? NO_THREADS;
      counts.set(thread.projectId, {
        threads: current.threads + 1,
        worktrees: current.worktrees + (thread.worktree === undefined ? 0 : 1),
      });
    }
    return counts;
  }, [threads]);

  return (
    <>
      <PinnedThreads
        threads={pinnedThreads}
        renderRow={(thread) => (
          <SelectableThreadRow
            key={thread.threadId}
            thread={thread}
            now={now}
            selection={selection}
          />
        )}
      />
      <SidebarGroup padding="section" className="min-h-0 flex-1">
        <div className="flex h-6 items-center gap-1">
          <SidebarGroupLabel className="h-auto shrink-0">Projects</SidebarGroupLabel>
          <ThreadFilterInput />
          <AddProjectDialog disabled={connection.status !== "connected"} command="project.add" />
        </div>
        <SidebarGroupContent className="min-h-0 overflow-y-auto [scrollbar-width:none]">
          {!filtering && projects.length === 0 && orphanThreads.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderAdd variant="bold" />
                </EmptyMedia>
                <EmptyTitle>
                  {connection.status === "connected" ? "No projects yet" : "Not connected"}
                </EmptyTitle>
                <EmptyDescription>
                  {connection.status === "connected"
                    ? "Add one to start a thread."
                    : "Connect to a server to see projects."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {filtering && order.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search variant="bold" />
                </EmptyMedia>
                <EmptyTitle>No matching threads</EmptyTitle>
                <EmptyDescription>Nothing in the sidebar has that in its title.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          <div className="grid min-w-0 gap-0.5">
            {shownProjects.map((project) => (
              <ProjectSection
                key={project.projectId}
                project={project}
                threads={threadsByProject.get(project.projectId) ?? []}
                counts={threadCounts.get(project.projectId) ?? NO_THREADS}
                rollup={rollups.get(project.projectId) ?? null}
                now={now}
                selection={selection}
              />
            ))}
            {orphanThreads.length > 0 ? (
              <div className="grid gap-0.5">
                <div className="flex h-7 items-center gap-2.5 rounded-xl px-2 text-sm text-sidebar-foreground">
                  <Folder variant="bold" className="size-4 shrink-0" />
                  <span className="min-w-0 truncate">Other threads</span>
                </div>
                <SidebarMenu>
                  {orphanThreads.map((thread) => (
                    <SelectableThreadRow
                      key={thread.threadId}
                      thread={thread}
                      now={now}
                      selection={selection}
                    />
                  ))}
                </SidebarMenu>
              </div>
            ) : null}
          </div>
        </SidebarGroupContent>
        <ThreadSelectionBar
          threads={selectedRows(order, selection.selection)}
          onClear={selection.clear}
        />
      </SidebarGroup>
    </>
  );
}

function SelectableThreadRow({
  thread,
  now,
  selection: { selection, select, clear },
}: {
  thread: ThreadSummary;
  now: number;
  selection: ThreadSelectionControls;
}) {
  return (
    <ThreadRow
      thread={thread}
      now={now}
      selected={selection.ids.has(thread.threadId)}
      selecting={selection.ids.size > 0}
      onSelect={(gesture) => select(thread.threadId, gesture)}
      onOpen={clear}
    />
  );
}

function ProjectSection({
  project,
  threads,
  counts,
  rollup,
  now,
  selection,
}: {
  project: ProjectSummary;
  /** The listed threads, folding already applied: the open one only, when folded. */
  threads: ReadonlyArray<ThreadSummary>;
  counts: ThreadCounts;
  rollup: ProjectStatusRollup | null;
  now: number;
  selection: ThreadSelectionControls;
}) {
  const [collapsed, setCollapsed] = useProjectCollapsed(project.projectId);

  return (
    <div className="grid gap-0.5">
      <div className="group/project flex h-7 items-center gap-1 rounded-xl text-sm text-sidebar-foreground">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-xl px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          {/* The folder turns into the disclosure chevron under the pointer. */}
          <span className="relative flex size-4 shrink-0 items-center justify-center">
            {collapsed ? (
              <Folder
                variant="bold"
                className="size-4 text-foreground/85 transition-opacity duration-150 ease-out group-hover/project:opacity-0"
              />
            ) : (
              <FolderOpen
                variant="bold"
                className="size-4 text-foreground/85 transition-opacity duration-150 ease-out group-hover/project:opacity-0"
              />
            )}
            <ChevronRight
              variant="bold"
              className={cn(
                "absolute size-4 text-foreground/85 opacity-0 transition-all duration-150 ease-out group-hover/project:opacity-100",
                !collapsed && "rotate-90",
              )}
            />
          </span>
          <span className="ml-1.5 min-w-0 flex-1 truncate">{project.name}</span>
        </button>
        {collapsed && rollup !== null ? <ProjectStatusMark rollup={rollup} /> : null}
        <ProjectTerminalsBadge projectId={project.projectId} />
        <span className="flex items-center opacity-0 transition-opacity duration-150 ease-out group-hover/project:opacity-100 group-focus-within/project:opacity-100 [&:has([data-popup-open])]:opacity-100">
          <ProjectRowMenu
            project={project}
            threadCount={counts.threads}
            worktreeCount={counts.worktrees}
          />
          <NewThreadButton projectId={project.projectId} onCreated={() => setCollapsed(false)} />
        </span>
      </div>
      {threads.length > 0 ? (
        <SidebarMenu>
          {threads.map((thread) => (
            <SelectableThreadRow
              key={thread.threadId}
              thread={thread}
              now={now}
              selection={selection}
            />
          ))}
        </SidebarMenu>
      ) : null}
    </div>
  );
}
