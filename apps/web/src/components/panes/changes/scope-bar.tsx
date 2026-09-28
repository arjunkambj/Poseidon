/**
 * The Changes pane's toolbar: what to compare, and the actions. One line; the
 * sum of what changed sits on the list's own summary line right under it.
 *
 * One Compare menu picks the comparison:
 *
 * - **Uncommitted** — the working tree against `HEAD`.
 * - **Branch** — everything the branch has done since it forked from its base,
 *   commits and uncommitted work together; the pair is spelled out beside it.
 * - **A turn** — what that turn changed, newest first. Restore joins the
 *   actions here, and puts the worktree back to how the turn left it.
 *
 * The split toggle puts old and new side by side. The scope and the layout are
 * remembered (`useChangesScope`, `useDiffStyle`) for every thread; which turn
 * is picked is the pane's own, and follows the latest turn until one is.
 */

import type { ReactNode } from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";
import { Toggle } from "@poseidon/ui/components/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import type { DiffStyle } from "@/state/ui";

import { Columns, Refresh } from "@honeyicons/react";

/** One entry of the Compare menu: a scope's name, or a turn's checkpoint ref. */
export interface CompareOption {
  readonly value: string;
  readonly label: string;
}

export const UNCOMMITTED = {
  value: "uncommitted",
  label: "Uncommitted",
} as const satisfies CompareOption;
export const BRANCH = { value: "branch", label: "Branch" } as const satisfies CompareOption;

export function ScopeBar({
  value,
  onValueChange,
  turns,
  range,
  restore,
  diffStyle,
  onDiffStyleChange,
  onRefresh,
}: {
  /** `uncommitted`, `branch`, or the shown turn's checkpoint ref. */
  value: string;
  onValueChange: (next: string) => void;
  /** The thread's turns, newest first. */
  turns: ReadonlyArray<CompareOption>;
  /** Beside the menu: the pair "Branch" compares, or nothing. */
  range: ReactNode;
  /** Leads the actions: the restore control, only while a turn is shown. */
  restore: ReactNode;
  diffStyle: DiffStyle;
  onDiffStyleChange: (next: DiffStyle) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
      <Select
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string" && next.length > 0) {
            onValueChange(next);
          }
        }}
        items={[UNCOMMITTED, BRANCH, ...turns]}
      >
        {/* Filled and weighted like the active dock tab above it. */}
        <SelectTrigger variant="secondary" className="shrink-0" aria-label="Compare">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          <SelectGroup>
            {[UNCOMMITTED, BRANCH].map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
          {turns.length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Turns</SelectLabel>
                {turns.map((turn) => (
                  <SelectItem key={turn.value} value={turn.value}>
                    {turn.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
        </SelectContent>
      </Select>
      <div className="flex min-w-0 items-center">{range}</div>
      <div className="flex-1" />
      {restore}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh changes"
              onClick={onRefresh}
            />
          }
        >
          <Refresh variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Refresh changes</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              size="icon-sm"
              aria-label="Split view"
              pressed={diffStyle === "split"}
              onPressedChange={(pressed) => onDiffStyleChange(pressed ? "split" : "unified")}
            />
          }
        >
          <Columns variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Show old and new side by side</TooltipContent>
      </Tooltip>
    </div>
  );
}
