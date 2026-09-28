/**
 * A project's "Done · N" section, under its active rows: the threads marked
 * done, or idle past the auto-done setting (`./thread-done`). Collapsed by
 * default and remembered per project; while collapsed it still shows the open
 * thread, so the sidebar never loses track of where you are. The rows are
 * the tree's own (`renderRow`, as `./pinned-threads` takes it), so they share
 * its selection. Nothing at all while the project has no done threads.
 */

import type * as React from "react";

import { Collapsible, CollapsibleTrigger } from "@poseidon/ui/components/collapsible";
import { SidebarMenu } from "@poseidon/ui/components/sidebar";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { useDoneExpanded } from "@/components/sidebar/thread-done";
import { cn } from "@/lib/utils";
import { ChevronRight } from "@honeyicons/react";

export function DoneThreads({
  projectId,
  count,
  threads,
  renderRow,
}: {
  readonly projectId: string;
  /** Every done thread in the project, listed or not. */
  readonly count: number;
  /** The listed ones: all of them while expanded, else the open one if done. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly renderRow: (thread: ThreadSummary) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useDoneExpanded(projectId);
  if (count === 0) {
    return null;
  }
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="grid gap-0.5">
        <div className="px-2">
          <CollapsibleTrigger variant="summary" className="h-7">
            <ChevronRight
              variant="bold"
              className={cn(
                "size-4 shrink-0 transition-transform duration-150 ease-out",
                expanded && "rotate-90",
              )}
            />
            <span className="min-w-0 truncate tabular-nums">Done · {count}</span>
          </CollapsibleTrigger>
        </div>
        {threads.length > 0 ? <SidebarMenu>{threads.map(renderRow)}</SidebarMenu> : null}
      </div>
    </Collapsible>
  );
}
