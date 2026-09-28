/**
 * How full the model's context window is: a small ring and the percentage,
 * which opens into a breakdown — used, window and remaining tokens over a
 * progress bar. `used` is the thread's last reported usage; a thread that has
 * not run yet passes 0 against the model's window, so the meter is there from
 * the first message rather than appearing after it.
 *
 * Given `compact` — only when the thread's bound session can compact on
 * demand (`./compact-now`) — the breakdown also offers "Compact now". A
 * disabled button shows no tooltip, so its reason is written beneath it.
 */

import { Button } from "@poseidon/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@poseidon/ui/components/popover";
import { Progress } from "@poseidon/ui/components/progress";
import { cn } from "@poseidon/ui/lib/utils";
import { Minimize } from "@honeyicons/react";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** From here on the ring turns destructive: compaction is close. */
const NEARLY_FULL = 0.8;

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** The "Compact now" action, offered only when the bound session can compact. */
export interface ContextCompact {
  readonly onCompact: () => void;
  /** Why the button is disabled right now, or null when it can run. */
  readonly disabledReason: string | null;
  readonly pending: boolean;
}

const share = (used: number, limit: number) => {
  const fraction = Math.min(1, used / Math.max(1, limit));
  return { fraction, percent: Math.round(fraction * 100) };
};

export function ContextMeter({
  used,
  limit,
  compact,
  className,
}: {
  readonly used: number;
  readonly limit: number;
  readonly compact?: ContextCompact;
  readonly className?: string;
}) {
  const { fraction, percent } = share(used, limit);
  const full = fraction >= NEARLY_FULL;
  return (
    <Popover>
      <PopoverTrigger
        nativeButton={false}
        render={
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 px-1.5 py-1 text-xs text-muted-foreground tabular-nums",
              className,
            )}
            aria-label={`Context window ${percent}% used`}
          />
        }
      >
        <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2" className="stroke-muted" />
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            className={full ? "stroke-destructive" : "stroke-foreground/85"}
          />
        </svg>
        {percent}%
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle>Context window</PopoverTitle>
        </PopoverHeader>
        <ContextBreakdown used={used} limit={limit} compact={compact} />
      </PopoverContent>
    </Popover>
  );
}

/** The popover's body: the token counts, the bar and, when offered, Compact now. */
export function ContextBreakdown({
  used,
  limit,
  compact,
}: {
  readonly used: number;
  readonly limit: number;
  readonly compact?: ContextCompact;
}) {
  const { percent } = share(used, limit);
  const rows = [
    ["Used", used],
    ["Window", limit],
    ["Remaining", Math.max(0, limit - used)],
  ] as const;
  return (
    <div className="flex flex-col gap-2.5">
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{tokens.format(value)} tokens</dd>
          </div>
        ))}
      </dl>
      <Progress value={percent} aria-label={`${percent}% of the context window used`} />
      {compact === undefined ? null : (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={compact.disabledReason !== null || compact.pending}
            onClick={compact.onCompact}
          >
            <Minimize variant="bold" data-icon="inline-start" />
            Compact now
          </Button>
          {compact.disabledReason === null ? null : (
            <p className="text-xs text-muted-foreground">{compact.disabledReason}</p>
          )}
        </div>
      )}
    </div>
  );
}
