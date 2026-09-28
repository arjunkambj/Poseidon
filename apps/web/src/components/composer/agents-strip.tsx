/**
 * The agents-working strip: one slim row above the composer while subagents
 * run in this thread — how many, the newest one's title and how long it has
 * been at it. Read from the thread snapshot's task rows
 * (`agentsStripSummary`); nothing is polled, and the row goes when no task is
 * working or the turn settles.
 *
 * View asks the thread view for the Agents tab (`state/agents-reveal.ts`) and
 * opens the newest subagent's entry there. Nothing opens the dock unasked:
 * the strip only shows, and the tab opens on the click.
 */

import { Button } from "@poseidon/ui/components/button";
import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";

import { agentEntryRowId, agentsStripSummary } from "@/components/panes/agents/subagents";
import { formatElapsed } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { useRequestAgentsTab } from "@/state/agents-reveal";
import { useSetRowDisclosures } from "@/state/ui";
import { Bot } from "@honeyicons/react";

function Elapsed({ since }: { readonly since: number }) {
  const now = useNow(1_000);
  return (
    <span className="shrink-0 text-muted-foreground tabular-nums">
      {formatElapsed(now - since)}
    </span>
  );
}

export function AgentsStrip({
  threadId,
  doc,
}: {
  readonly threadId: string;
  readonly doc: ThreadDetailSnapshot;
}) {
  const requestAgentsTab = useRequestAgentsTab();
  const setDisclosures = useSetRowDisclosures();
  const summary = agentsStripSummary(doc.items, doc.currentTurnId);
  if (summary === null) {
    return null;
  }
  const { count, newest } = summary;
  const view = () => {
    setDisclosures([agentEntryRowId(newest.item.itemId)], true);
    requestAgentsTab(threadId);
  };
  return (
    <div
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-xl bg-card px-3 py-0.5 text-xs"
      aria-label="Agents working"
    >
      <Bot variant="bold" className="size-3.5 shrink-0" />
      <span className="shrink-0 text-muted-foreground">
        {count} {count === 1 ? "agent" : "agents"} working
      </span>
      <span className="min-w-0 flex-1 truncate" title={newest.title}>
        {newest.title}
      </span>
      {newest.startedAt === undefined ? null : <Elapsed since={newest.startedAt} />}
      <Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={view}>
        View
      </Button>
    </div>
  );
}
