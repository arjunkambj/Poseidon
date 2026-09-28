/**
 * The round "jump to latest" button over the bottom of the timeline. It shows
 * only while the list sits away from its end — where it stops following new
 * rows — and scrolls back down when pressed. `timeline.jumpToLatest` does the
 * same from the keyboard; the timeline answers it, and the tooltip shows its
 * chord.
 *
 * A dot on the button says something arrived below while the reader was away:
 * the thread changed (`activity`, the snapshot's items) while the list was not
 * near its end. Rows settling to their measured heights while the reader
 * scrolls through history do not count. Reaching the end, by any route,
 * clears it. While a just-sent message is carried to the top the list is away
 * from its end on purpose, so the button stays hidden then.
 *
 * A thread reopened at the reader's saved place (`opensAway`) does not start
 * at its end: the button reads the list's flag once it has laid out instead.
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { LegendListRef } from "@legendapp/list/react";
import * as React from "react";

import { CommandKbd } from "@/lib/shortcuts";
import { ArrowDown } from "@honeyicons/react";

export function JumpToLatest({
  listRef,
  activity,
  hidden,
  opensAway = false,
  onJump,
}: {
  listRef: React.RefObject<LegendListRef | null>;
  /** Changes whenever the thread gains or updates rows. */
  activity: unknown;
  /** The list is away from its end on purpose, carrying a sent message to the top. */
  hidden: boolean;
  /** The list opens at a saved place rather than at its end. */
  opensAway?: boolean;
  onJump: () => void;
}) {
  // Starts hidden: the list opens at its end, and its own flag reads false until
  // the first layout, which would flash the button on every mount.
  const [nearEnd, setNearEnd] = React.useState(!opensAway);
  const [unseen, setUnseen] = React.useState(false);

  const opensAwayRef = React.useRef(opensAway);
  React.useEffect(() => {
    const state = listRef.current?.getState();
    if (state === undefined) {
      return;
    }
    // Laid out by now: a saved place near the end hides the button again.
    if (opensAwayRef.current) {
      setNearEnd(state.isNearEnd);
    }
    return state.listen("isNearEnd", (near) => {
      setNearEnd(near);
      if (near) {
        setUnseen(false);
      }
    });
  }, [listRef]);

  const awayRef = React.useRef(false);
  awayRef.current = !nearEnd && !hidden;
  const firstActivity = React.useRef(true);
  React.useEffect(() => {
    if (firstActivity.current) {
      firstActivity.current = false;
      return;
    }
    if (awayRef.current) {
      setUnseen(true);
    }
  }, [activity]);

  if (nearEnd || hidden) {
    return null;
  }
  const label = unseen ? "Jump to latest, new activity" : "Jump to latest";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              shape="pill"
              aria-label={label}
              className="pointer-events-auto relative"
              onClick={() => {
                setUnseen(false);
                onJump();
              }}
            />
          }
        >
          <ArrowDown variant="bold" />
          {unseen ? (
            <span
              aria-hidden
              data-slot="activity-dot"
              className="absolute top-0 right-0 size-1.5 rounded-full bg-primary"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipContent>
          Jump to latest
          <CommandKbd command="timeline.jumpToLatest" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
