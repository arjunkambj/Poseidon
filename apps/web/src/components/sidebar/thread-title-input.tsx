/**
 * The title field a sidebar row shows while it is being renamed — see
 * `./thread-rename`.
 *
 * It opens prefilled with the title, all of it selected. Enter sends
 * `thread.rename` when the trimmed draft is a new, non-empty title (through
 * `./use-sidebar-actions`, so `Mod+Z` takes it back); Escape and a click away
 * keep the old title. Either way the row goes back to its link.
 *
 * Opened from a row menu, the field mounts while that menu is still closing,
 * and base-ui then hands focus back to the menu's trigger — a blur that would
 * cancel the rename before anyone typed. So focus is taken again on the next
 * frame, and a blur in the first moments after mount takes it back rather than
 * cancelling.
 */

import * as React from "react";

import { Input } from "@poseidon/ui/components/input";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { renameTarget } from "@/components/sidebar/thread-rename";
import { useSidebarActions } from "@/components/sidebar/use-sidebar-actions";

/** Long enough to outlast a closing menu's exit animation and focus return. */
const SETTLE_MS = 300;

export function ThreadTitleInput({
  thread,
  onDone,
}: {
  thread: ThreadSummary;
  /** Ends the rename; called once, after a commit or a cancel. */
  onDone: () => void;
}) {
  const actions = useSidebarActions();
  const ref = React.useRef<HTMLInputElement>(null);
  const mountedAt = React.useRef(0);
  const done = React.useRef(false);

  const grab = React.useCallback(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  React.useEffect(() => {
    mountedAt.current = performance.now();
    grab();
    const frame = requestAnimationFrame(grab);
    return () => cancelAnimationFrame(frame);
  }, [grab]);

  const finish = (draft: string | null) => {
    if (done.current) {
      return;
    }
    done.current = true;
    onDone();
    const title = draft === null ? null : renameTarget(thread.title, draft);
    if (title !== null) {
      void actions.rename(thread, title);
    }
  };

  return (
    <Input
      ref={ref}
      defaultValue={thread.title}
      aria-label="Thread title"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          finish(event.currentTarget.value);
        } else if (event.key === "Escape") {
          // Kept from the window listeners: `thread.interrupt` and the
          // selection's Escape answer there.
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => {
        if (performance.now() - mountedAt.current < SETTLE_MS) {
          requestAnimationFrame(grab);
          return;
        }
        finish(null);
      }}
      // The browser's own menu (cut, paste) rather than the row's.
      onContextMenu={(event) => event.stopPropagation()}
    />
  );
}
