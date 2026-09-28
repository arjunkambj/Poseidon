/**
 * The harness picker's pieces: the rail of round harness avatars and the
 * 28px model rows its flyouts and search results are made of. None of them
 * takes focus — the search input keeps it and names the highlighted option
 * with `aria-activedescendant` — so every one swallows `mousedown`, and the
 * pointer only ever highlights (hover) or picks (click).
 */

import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { cn } from "@poseidon/ui/lib/utils";
import type * as React from "react";

import { HarnessAvatar } from "@/components/harness-avatar";
import { ProviderMark } from "@/components/ui/icons/provider-mark";
import type { HarnessRailEntry, HarnessRailItem } from "@/lib/harness-picker";
import { Check } from "@honeyicons/react";

import { harnessOptionId } from "./picker-keys";

export const SWITCH_CONNECTOR_TOOLTIP = "Start a new thread to switch connector";

/** Keeps DOM focus in the search input when an option is pressed. */
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

/**
 * The column of harness avatars. The harness whose flyout shows is filled, and
 * the current pick's harness has its avatar ringed in the primary colour. A
 * locked harness stays
 * hoverable, so its flyout still says what it offers, but reads as disabled.
 */
export function HarnessRailColumn({
  base,
  rail,
  shown,
  onHover,
}: {
  readonly base: string;
  readonly rail: ReadonlyArray<HarnessRailEntry>;
  /** The rail index whose flyout is open, or `null` while search results show. */
  readonly shown: number | null;
  readonly onHover: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Harnesses"
      aria-orientation="vertical"
      className="flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-r pr-1.5"
    >
      {rail.map((entry, index) => (
        <Tooltip key={entry.instanceId}>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant={shown === index ? "secondary" : "ghost"}
                size="icon-sm"
                shape="pill"
                role="option"
                id={harnessOptionId(base, index)}
                tabIndex={-1}
                aria-label={entry.label}
                aria-selected={shown === index}
                aria-disabled={entry.locked || undefined}
                aria-description={entry.locked ? SWITCH_CONNECTOR_TOOLTIP : undefined}
                data-current={entry.current || undefined}
                onMouseDown={keepFocus}
                onMouseEnter={() => onHover(index)}
                onClick={() => onHover(index)}
              />
            }
          >
            <span
              className={cn(
                "inline-flex rounded-full",
                entry.current && "ring-2 ring-primary",
                entry.locked && "opacity-50",
              )}
            >
              <HarnessAvatar monogram={entry.monogram} iconKey={entry.iconKey} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">
            <span className="flex flex-col">
              <span>{entry.label}</span>
              {entry.locked ? <span>{SWITCH_CONNECTOR_TOOLTIP}</span> : null}
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * One model: its label, its effort ladder in muted text, and a check when it
 * is the current pick. Its tagline (or, without one, its family) is the native
 * hover tooltip: a second line would break the 28px row. Under a harness whose
 * models span providers, the provider's mark (or an empty box the same size)
 * sits before the label. In search results the harness's avatar (logo, else
 * monogram) leads it, and when any result has a mark (`markSlot`) every result
 * keeps the slot, so the labels line up. In compare mode (`checked` given) a
 * checkbox leads it instead of the check: the row is what a click lands on, so
 * the checkbox only shows the state.
 */
export function PickerRow({
  id,
  item,
  active,
  harness,
  markSlot = false,
  checked,
  onHover,
  onChoose,
}: {
  readonly id: string;
  readonly item: HarnessRailItem;
  readonly active: boolean;
  /** The harness the row is under, shown only in search results. */
  readonly harness?: HarnessRailEntry;
  /** Keep the provider slot even when this row has no provider. */
  readonly markSlot?: boolean;
  /** Compare mode: whether the model is ticked. */
  readonly checked?: boolean;
  readonly onHover: () => void;
  readonly onChoose: () => void;
}) {
  return (
    <div
      role="option"
      id={id}
      aria-selected={active}
      aria-disabled={item.disabled || undefined}
      aria-checked={checked}
      aria-label={harness === undefined ? undefined : `${item.label}, ${harness.label}`}
      data-current={item.current || undefined}
      title={item.description ?? item.family}
      className={cn(
        "flex h-7 shrink-0 cursor-default items-center gap-2 rounded-md px-2 py-0.5 text-sm",
        active && "bg-accent text-accent-foreground",
        item.disabled && "opacity-50",
      )}
      onMouseDown={keepFocus}
      onMouseEnter={onHover}
      onClick={item.disabled ? undefined : onChoose}
    >
      {checked === undefined ? null : (
        <Checkbox checked={checked} disabled={item.disabled} tabIndex={-1} aria-hidden />
      )}
      {harness === undefined ? null : (
        <HarnessAvatar monogram={harness.monogram} iconKey={harness.iconKey} />
      )}
      {item.provider === undefined && !markSlot ? null : (
        <ProviderMark providerKey={item.provider} />
      )}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.efforts === undefined ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{item.efforts}</span>
      )}
      {item.current ? (
        <Check variant="bold" aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <span aria-hidden className="size-3.5 shrink-0" />
      )}
    </div>
  );
}
