/**
 * The dock's Agents tab: the thread's subagents, grouped Working, Done and
 * Failed, newest first in each, with a count on every group and empty groups
 * left out. Everything comes from the snapshot the dock already holds — the
 * thread's `task` rows (`./subagents`) — so nothing is fetched or polled; the
 * tab follows the thread as its snapshot updates. Each entry is an
 * `AgentEntry`, whose target button scrolls the timeline to its task row.
 */

import * as React from "react";

import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";

import { PaneMessage } from "@/components/panes/files/pane-message";
import { turnInFlight } from "@/lib/turn";
import { Bot } from "@honeyicons/react";

import { AgentEntry } from "./agent-entry";
import { groupSubagents, subagentsOf, type Subagent, type SubagentGroups } from "./subagents";

const SECTIONS: ReadonlyArray<{ readonly key: keyof SubagentGroups; readonly title: string }> = [
  { key: "working", title: "Working" },
  { key: "done", title: "Done" },
  { key: "failed", title: "Failed" },
];

function Section({
  threadId,
  title,
  subagents,
}: {
  readonly threadId: string;
  readonly title: string;
  readonly subagents: ReadonlyArray<Subagent>;
}) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="flex h-7 items-center gap-1.5 px-3 py-1 type-micro font-medium text-muted-foreground"
      >
        {title}
        <span className="tabular-nums">{subagents.length}</span>
      </h3>
      <ul className="flex flex-col">
        {subagents.map((subagent) => (
          <li key={subagent.item.itemId}>
            <AgentEntry threadId={threadId} subagent={subagent} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentsPane({ snapshot }: { readonly snapshot: ThreadDetailSnapshot }) {
  const running = turnInFlight(snapshot);
  const groups = React.useMemo(
    () => groupSubagents(subagentsOf(snapshot.items, running)),
    [snapshot.items, running],
  );
  const shown = SECTIONS.filter(({ key }) => groups[key].length > 0);
  if (shown.length === 0) {
    return (
      <PaneMessage
        icon={Bot}
        text="No subagents yet"
        detail="Subagents the agent starts show here."
      />
    );
  }
  return (
    <div className="flex flex-col gap-1 py-1">
      {shown.map(({ key, title }) => (
        <Section key={key} threadId={snapshot.threadId} title={title} subagents={groups[key]} />
      ))}
    </div>
  );
}
