/**
 * A small count of the shells still running in a project's own folder — the
 * terminals the project owns rather than a thread — on the New task header,
 * beside its terminal toggle, and on the project's sidebar row.
 *
 * They are the ones left behind: a worktree thread started from New task
 * does not take them (it runs elsewhere), and a shell started on New task
 * again later stays with the project until the next local thread started
 * there takes them all (`./use-terminal-hand-over`), when the count drops to
 * nothing.
 *
 * It reads the project's `terminal.list` through `./use-running-terminals`:
 * refetched on connecting, after every open, close and hand-over, and on a
 * return to the window, since a shell nobody is watching can exit without
 * the client hearing of it. Both badges of a project read the same list atom,
 * and the return refetch is shared by that atom (`useSharedWindowReturn`), so
 * the list is fetched once per trigger however many badges show it. Nothing
 * shows while none is running. A thread's own running shells show on its
 * sidebar row instead (`./thread-terminals-mark`), from one listing of every
 * thread's running terminals.
 */

import type { ProjectId } from "@poseidon/contracts/ids";
import { Badge } from "@poseidon/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { runningTerminalsLabel } from "@/components/terminal/running-terminals";
import { useRunningTerminals } from "@/components/terminal/use-running-terminals";
import { Terminal } from "@honeyicons/react";

export function ProjectTerminalsBadge({ projectId }: { projectId: ProjectId }) {
  const count = useRunningTerminals({ projectId }).length;
  if (count === 0) {
    return null;
  }
  const label = runningTerminalsLabel(count);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="secondary" role="status" aria-label={label} className="shrink-0" />}
      >
        <Terminal variant="bold" data-icon="inline-start" />
        {count}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
