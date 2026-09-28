/**
 * A small terminal mark beside a thread row's title while any of the
 * thread's own terminals still runs a shell, with the count when more than
 * one does. The tooltip names them by title — a terminal summary carries no
 * foreground command. The row picks them out of the one listing of every
 * thread's running terminals (`useThreadRunningTerminals` in
 * `./use-running-terminals`), so the sidebar does not list thread by thread.
 */

import type { TerminalSummary } from "@poseidon/contracts/terminal";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { threadTerminalsLabel } from "@/components/terminal/running-terminals";
import { cn } from "@/lib/utils";
import { Terminal } from "@honeyicons/react";

export function ThreadTerminalsMark({
  terminals,
  className,
}: {
  terminals: ReadonlyArray<TerminalSummary>;
  className?: string;
}) {
  if (terminals.length === 0) {
    return null;
  }
  const label = threadTerminalsLabel(terminals.map((terminal) => terminal.title));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={cn("flex shrink-0 items-center gap-0.5 text-muted-foreground", className)}
          />
        }
      >
        <Terminal variant="bold" className="size-3.5" />
        {terminals.length > 1 ? (
          <span className="type-micro tabular-nums">{terminals.length}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
