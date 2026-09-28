/**
 * `work-group` — a run of work rows folded behind one disclosure that says
 * what the run did: "Ran 2 commands, edited 1 file", or "Thought for 2s" for
 * reasoning alone (`work-summary.ts`). Failures surface beside the label so a
 * broken step is visible without expanding. The body re-renders each folded
 * item through the same row dispatcher.
 *
 * The running turn's trailing burst (`group.live`) reads as its newest step
 * instead — "Running pnpm test", "Thinking…" (`live-step.ts`) — with that
 * step's spinner and "N steps" beside it. It is the same row with the same id,
 * so it keeps its disclosure state and does not remount when the burst stops
 * being live.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { useMemo } from "react";

import type { TimelineWorkGroupRow } from "@/components/timeline/fold";
import { liveStepCount, liveStepLabel } from "@/components/timeline/live-step";
import { DisclosureRow, FailedCount } from "@/components/timeline/row-shell";
import { TimelineItemView } from "@/components/timeline/timeline-item";
import { withFailures, workGroupLabel } from "@/components/timeline/work-summary";
import { Layers } from "@honeyicons/react";

export function WorkGroupRow({
  group,
  childrenByParent,
}: {
  group: TimelineWorkGroupRow;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}) {
  const { items, durationMs, live } = group;
  const label = useMemo(
    () => (live ? liveStepLabel(items) : workGroupLabel(items, durationMs)),
    [items, durationMs, live],
  );
  const steps = live ? liveStepCount(items) : 0;
  return (
    <DisclosureRow
      rowId={group.id}
      icon={Layers}
      label={<span title={withFailures(label, group.failedCount)}>{label}</span>}
      status={live ? items[items.length - 1]?.status : undefined}
      meta={
        <>
          {steps > 1 ? (
            <span className="ml-1 shrink-0 type-micro text-muted-foreground tabular-nums">
              {steps} steps
            </span>
          ) : null}
          <FailedCount count={group.failedCount} />
        </>
      }
    >
      <div className="flex flex-col gap-1">
        {group.items.map((item) => (
          <TimelineItemView key={item.itemId} item={item} childrenByParent={childrenByParent} />
        ))}
      </div>
    </DisclosureRow>
  );
}
