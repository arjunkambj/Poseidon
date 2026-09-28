/**
 * The terminal drawer's small pieces: its icon buttons, the tab strip and one
 * tab, and the message it shows in place of a terminal. Stock `Button`,
 * `Tooltip` and `Empty` parts, kept apart from the drawer's own logic.
 */

import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import type { TerminalTab } from "@/components/terminal/drawer-state";
import { Close, Stop, Terminal } from "@honeyicons/react";

export function IconButton({
  label,
  ariaLabel = label,
  onClick,
  disabled,
  children,
  hint,
}: {
  /** The tooltip, and the accessible name unless `ariaLabel` says more. */
  label: string;
  ariaLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  // The trigger wraps the button rather than being it: a disabled button
  // takes no pointer events, and the tooltip is where a disabled button says
  // why — the New terminal button at the cap, say.
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Button
          type="button"
          variant="ghost"
          tone="muted"
          size="icon-xs"
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * How far a wheel event scrolls the tab strip sideways, in pixels. A plain
 * mouse wheel only turns vertically, and the strip has no vertical scroll, so
 * a mostly vertical turn scrolls it sideways; a trackpad's sideways swipe
 * keeps its own direction. Line and page deltas are scaled to pixels.
 */
export const stripScrollDelta = (
  wheel: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number },
  pageWidth: number,
): number => {
  const delta = Math.abs(wheel.deltaY) > Math.abs(wheel.deltaX) ? wheel.deltaY : wheel.deltaX;
  const unit = wheel.deltaMode === 1 ? LINE_PIXELS : wheel.deltaMode === 2 ? pageWidth : 1;
  return delta * unit;
};

/** What one wheel line is taken to be, the way browsers scroll a line. */
const LINE_PIXELS = 16;

/**
 * The tabs. A long title shrinks, truncating, before the strip overflows —
 * never so far that a default title loses its number, which is all that tells
 * "Terminal 3" from "Terminal 4". Past that the strip scrolls sideways, fading
 * at an edge with more tabs beyond, and a vertical wheel scrolls it too, so
 * every tab stays reachable by mouse.
 */
export function TerminalTabStrip({ children }: { children: React.ReactNode }) {
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const strip = event.currentTarget;
    strip.scrollLeft += stripScrollDelta(event, strip.clientWidth);
  };
  return (
    <div
      role="tablist"
      aria-label="Terminals"
      onWheel={onWheel}
      className="flex min-w-0 flex-1 scroll-fade-x items-center gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
    >
      {children}
    </div>
  );
}

export function TerminalTabButton({
  tab,
  active,
  onSelect,
  onClose,
  onStop,
}: {
  tab: TerminalTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  /** Interrupts a running script (Ctrl-C); the close button stays the hard kill. */
  onStop: () => void;
}) {
  // The strip scrolls sideways once the tabs outgrow it; the tab in front —
  // one just opened, say — is scrolled into sight so the strip always shows
  // which terminal the xterm below is.
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);
  return (
    <div ref={ref} className="flex max-w-48 min-w-30 shrink items-center">
      <Button
        type="button"
        role="tab"
        aria-selected={active}
        size="xs"
        variant={active ? "secondary" : "ghost"}
        tone={active ? "default" : "muted"}
        className="min-w-0 shrink"
        onClick={onSelect}
      >
        <Terminal variant="bold" />
        <span className="truncate">{tab.title}</span>
        {tab.status === "exited" ? (
          <span className="shrink-0 text-muted-foreground">exited</span>
        ) : null}
      </Button>
      {tab.script !== null && tab.status === "running" ? (
        <IconButton label={`Stop ${tab.script.name}`} onClick={onStop}>
          <Stop variant="bold" />
        </IconButton>
      ) : null}
      <IconButton label="Close terminal" ariaLabel={`Close ${tab.title}`} onClick={onClose}>
        <Close variant="bold" />
      </IconButton>
    </div>
  );
}

export function DrawerMessage({
  title,
  message,
  action,
}: {
  title: string;
  message?: string | null;
  action?: React.ReactNode;
}) {
  // Scrolling rather than spilling out of the drawer: a drawer dragged down
  // to its minimum has room for little more than the title, and the action
  // below it has to stay within reach.
  return (
    <div className="flex size-full flex-col overflow-y-auto">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Terminal variant="bold" />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          {message ? <EmptyDescription>{message}</EmptyDescription> : null}
        </EmptyHeader>
        {action ? <EmptyContent>{action}</EmptyContent> : null}
      </Empty>
    </div>
  );
}
