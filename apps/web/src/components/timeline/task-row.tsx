/**
 * `task` — a subagent run. The row shows the task title and status; expanding
 * it reveals the nested rows the subagent produced (items whose `parentItemId`
 * is this task). Collapsed by default, including while running, so long nested
 * work does not dominate the main transcript.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import { DisclosureRow } from "@/components/timeline/row-shell";
import { FindText } from "@/components/timeline/thread-find-context";
import { TimelineItemView } from "@/components/timeline/timeline-item";
import { Bot } from "@honeyicons/react";

export function TaskRow({
  item,
  children,
  childrenByParent,
}: {
  item: ItemSnapshot;
  children: ReadonlyArray<ItemSnapshot>;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}) {
  return (
    <DisclosureRow
      rowId={item.itemId}
      icon={Bot}
      label={item.text === undefined ? "Subagent task" : <FindText text={item.text} />}
      status={item.status}
      meta={
        children.length > 0 ? (
          <span className="ml-1 shrink-0 type-micro text-muted-foreground">
            {children.length} {children.length === 1 ? "row" : "rows"}
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-1.5">
        {children.map((child) => (
          <TimelineItemView key={child.itemId} item={child} childrenByParent={childrenByParent} />
        ))}
        {children.length === 0 && item.status === "in_progress" ? (
          <p className="type-micro text-muted-foreground">Subagent is working…</p>
        ) : null}
      </div>
    </DisclosureRow>
  );
}
