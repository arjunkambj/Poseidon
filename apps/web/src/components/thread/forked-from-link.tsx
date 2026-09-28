/**
 * Where a forked thread came from: "Forked from <title>", linking to the
 * source while it still exists and plain text once it is gone. The title is
 * the source's when the fork was made.
 *
 * The greeting of an empty fork shows the sentence; the thread header shows
 * the fork icon beside the title, with the sentence as its tooltip, so the
 * link stays in reach once the conversation has scrolled it away.
 */

import type { ForkedFrom } from "@poseidon/contracts/orchestration";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { Link } from "@tanstack/react-router";

import { useThreadList } from "@/state/hooks";
import { GitFork } from "@honeyicons/react";

const useSourceExists = (forkedFrom: ForkedFrom): boolean =>
  useThreadList().some(
    (thread) => thread.threadId === forkedFrom.threadId && thread.status !== "deleted",
  );

/** The sentence, for the empty thread's greeting. */
export function ForkedFromLink({ forkedFrom }: { readonly forkedFrom: ForkedFrom }) {
  const exists = useSourceExists(forkedFrom);
  return (
    <p className="flex max-w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      <GitFork variant="bold" className="size-4 shrink-0" />
      <span className="shrink-0">Forked from</span>
      {exists ? (
        <Link
          to="/t/$threadId"
          params={{ threadId: forkedFrom.threadId }}
          className="min-w-0 truncate text-foreground underline-offset-4 hover:underline"
        >
          {forkedFrom.title}
        </Link>
      ) : (
        <span className="min-w-0 truncate">{forkedFrom.title}</span>
      )}
    </p>
  );
}

/** The header's icon: a link to the source while it exists, its tooltip the sentence. */
export function ForkedFromIcon({ forkedFrom }: { readonly forkedFrom: ForkedFrom }) {
  const exists = useSourceExists(forkedFrom);
  const label = exists
    ? `Forked from ${forkedFrom.title}`
    : `Forked from ${forkedFrom.title}, which no longer exists`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          exists ? (
            <Button
              variant="ghost"
              tone="muted"
              size="icon-xs"
              aria-label={label}
              nativeButton={false}
              render={<Link to="/t/$threadId" params={{ threadId: forkedFrom.threadId }} />}
            />
          ) : (
            <span
              tabIndex={0}
              aria-label={label}
              className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground"
            />
          )
        }
      >
        <GitFork variant="bold" className="size-3" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
