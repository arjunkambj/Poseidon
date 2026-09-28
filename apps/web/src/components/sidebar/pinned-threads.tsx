/**
 * The "Pinned" group above Projects: the pinned threads, newest pin first,
 * drawn with the same row as the tree (`renderRow`, which `ProjectTree` hands
 * in so the pinned rows share its selection). Nothing at all while nothing is
 * pinned. Which threads are pinned, and the order, come from `./thread-order`
 * and `./thread-pins`.
 *
 * The list scrolls on its own past a few rows, so a long pin list cannot push
 * the projects out of the sidebar.
 */

import type * as React from "react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@poseidon/ui/components/sidebar";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

export function PinnedThreads({
  threads,
  renderRow,
}: {
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly renderRow: (thread: ThreadSummary) => React.ReactNode;
}) {
  if (threads.length === 0) {
    return null;
  }
  return (
    <SidebarGroup padding="section" className="shrink-0">
      <div className="flex h-6 items-center gap-1">
        <SidebarGroupLabel className="h-auto flex-1">Pinned</SidebarGroupLabel>
      </div>
      <SidebarGroupContent className="max-h-64 overflow-y-auto [scrollbar-width:none]">
        <SidebarMenu>{threads.map(renderRow)}</SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
