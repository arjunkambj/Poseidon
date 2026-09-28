/**
 * The command palette's Messages group: threads whose message text — what the
 * user wrote and what the agent answered, never tool output — holds the query,
 * across every project, archived threads included and marked.
 *
 * Past two characters the palette asks the server (`threads.searchMessages`)
 * once typing pauses. Each pause is a new member of the query-keyed search
 * atom, so the member for the older query loses its reader and its call is
 * cancelled. Every row here carries `MESSAGE_HIT_KEYWORD`: the server already
 * matched it, so the palette keeps it at a score below every title hit, and
 * the Threads group ranks first.
 *
 * Picking a hit leaves a find request for its thread before navigating, so the
 * thread opens with the find bar searching the query at that message.
 */

import * as React from "react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";

import type { MessageSearchQuery } from "@poseidon/client-runtime/searchAtoms";
import { CommandGroup, CommandItem, CommandSeparator } from "@poseidon/ui/components/command";

import { messageHitRows } from "@/components/Layout/message-hit-rows";
import { useSearchAtoms } from "@/components/Layout/message-search-atoms";
import { FIND_MARK_CLASSES } from "@/components/timeline/rehype-find-marks";
import { MESSAGE_HIT_KEYWORD, messageSearchQuery } from "@/lib/palette-query";
import { requestThreadFind } from "@/lib/thread-find-request";
import { useConnectionState, useProjects } from "@/state/hooks";
import { Archive, Chat, Spinner } from "@honeyicons/react";

/** How long typing has to pause before the server is asked. */
const SEARCH_DEBOUNCE_MS = 200;

const MARK_CLASS = FIND_MARK_CLASSES.join(" ");
const KEYWORDS = [MESSAGE_HIT_KEYWORD];

type GroupProps = { readonly search: string; readonly onDone: () => void };

/** `value`, once it has held still for `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function MessageHitsGroup({ search, onDone }: GroupProps) {
  const query = messageSearchQuery(search);
  const settled = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const connected = useConnectionState().status === "connected";

  // Offline there is nobody to ask; the title hits still work.
  if (query === null || !connected) {
    return null;
  }

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading="Messages">
        {settled === query ? (
          <MessageHits query={query} onDone={onDone} />
        ) : (
          <StatusRow value="message search pending" searching>
            Searching messages…
          </StatusRow>
        )}
      </CommandGroup>
    </>
  );
}

/** The hits for a settled query; mounting it is what asks the server. */
function MessageHits({ query, onDone }: { readonly query: string; readonly onDone: () => void }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const result = useAtomValue(useSearchAtoms().messageSearchAtom(query));

  const outcome: MessageSearchQuery | null = AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result)
      ? { _tag: "error", message: "Could not search messages." }
      : null;

  if (outcome === null) {
    return (
      <StatusRow value="message search pending" searching>
        Searching messages…
      </StatusRow>
    );
  }
  if (outcome._tag === "error") {
    return <StatusRow value="message search failed">{outcome.message}</StatusRow>;
  }

  return messageHitRows(outcome.hits, projects, query).map(
    ({ value, hit, projectLabel, segments }) => (
      <CommandItem
        key={value}
        value={value}
        keywords={KEYWORDS}
        onSelect={() => {
          onDone();
          // Before navigating, so the thread's timeline finds it when it mounts.
          requestThreadFind({ threadId: hit.threadId, query, itemId: hit.itemId });
          void navigate({ to: "/t/$threadId", params: { threadId: hit.threadId } });
        }}
      >
        {hit.archived ? <Archive variant="bold" /> : <Chat variant="bold" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{hit.title}</span>
            <span className="shrink-0 type-micro text-muted-foreground">{projectLabel}</span>
          </span>
          <span className="truncate type-micro text-muted-foreground">
            {segments.map((segment, index) =>
              segment.match ? (
                <mark key={index} className={MARK_CLASS}>
                  {segment.text}
                </mark>
              ) : (
                <React.Fragment key={index}>{segment.text}</React.Fragment>
              ),
            )}
          </span>
        </span>
      </CommandItem>
    ),
  );
}

/**
 * A row that says what the search is doing. It is disabled, so the arrows
 * skip it, but it still counts as a result, so "No results found" does not
 * show beside a search still under way.
 */
function StatusRow({
  value,
  searching = false,
  children,
}: {
  readonly value: string;
  readonly searching?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <CommandItem value={value} keywords={KEYWORDS} disabled>
      {searching ? <Spinner variant="bold" /> : null}
      <span className="text-muted-foreground">{children}</span>
    </CommandItem>
  );
}
