/**
 * One labelled picker in the thread settings row (`./header-controls`): the
 * runtime mode and the effort. The model has its own picker (`./model-picker`)
 * because it is sectioned by connector instance.
 *
 * `open`/`onOpenChange` make it controllable, so a keybinding can open it the
 * way a click would. A `restart` capability disables it behind a tooltip, and
 * then it does not open for a key either.
 */

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { CapabilitySwitch } from "@poseidon/contracts/runtime";
import { cn } from "@poseidon/ui/lib/utils";
import type { HoneyIcon } from "@honeyicons/react";

export interface HeaderOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export const RESTART_TOOLTIP =
  "Applies only on session restart — the running session keeps its settings";
export const NEXT_TURN_HINT = "applies next turn";

/**
 * `capability` is the connector's switch behaviour for this knob; absent means
 * the setting is a server-side mode read at turn start, which is exactly the
 * per-turn contract — so the hint stays.
 */
export function HeaderSelect({
  className,
  collapseValue = false,
  icon: Glyph,
  label,
  value,
  options,
  capability,
  open,
  onOpenChange,
  onPick,
}: {
  readonly className?: string;
  /** Hides the value in a narrow toolbar and keeps the icon; the label stays the name. */
  readonly collapseValue?: boolean;
  readonly icon: HoneyIcon;
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<HeaderOption>;
  readonly capability: CapabilitySwitch | "next-turn";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (value: string) => void;
}) {
  const restartLocked = capability === "restart";
  const nextTurn = capability === "per-turn" || capability === "next-turn";
  // The current value may be absent from the option list (a stale model id) —
  // offer it verbatim so the picker never lies about the setting.
  const items = options.some((option) => option.value === value)
    ? options
    : [{ value, label: value }, ...options];

  const select = (
    <Select
      value={value}
      disabled={restartLocked}
      open={open && !restartLocked}
      onOpenChange={(next) => onOpenChange(next)}
      onValueChange={(next) => {
        if (typeof next === "string" && next.length > 0 && next !== value) {
          onPick(next);
        }
      }}
      items={items.map((item) => ({ value: item.value, label: item.label }))}
    >
      <SelectTrigger
        aria-label={label}
        title={nextTurn ? NEXT_TURN_HINT : label}
        variant="composer"
      >
        <span className="flex items-center gap-1">
          <Glyph variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
          {collapseValue ? (
            <SelectValue className="max-w-52 @max-xs/toolbar:hidden" />
          ) : (
            <SelectValue className="max-w-52" />
          )}
        </span>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-56">
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.label}</span>
                {item.description === undefined ? null : (
                  <span className="text-xs whitespace-normal text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      {restartLocked ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>{select}</TooltipTrigger>
          <TooltipContent>{RESTART_TOOLTIP}</TooltipContent>
        </Tooltip>
      ) : (
        select
      )}
    </span>
  );
}
