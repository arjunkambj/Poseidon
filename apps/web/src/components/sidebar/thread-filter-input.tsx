/**
 * The title filter's field in the Projects header, and the palette command
 * that focuses it — see `./thread-filter` for what the query does.
 *
 * Typing narrows the tree at once; Escape clears the query, and on an empty
 * field gives the focus back. Escape stops there, so the window's own Escape
 * handlers (stopping a turn, clearing the selection) never see it.
 *
 * `threads.filter` is claimed by `ThreadFilterShortcut`, mounted beside the
 * home layout's sidebar toggle rather than in the tree: on a narrow window the
 * sidebar is a sheet and the tree is not mounted until it opens. The command
 * opens the sidebar, then leaves a focus request the field takes when it is on
 * screen. A pick from the palette fires while the palette is still closing,
 * and its focus return lands after ours, so a blur shortly after a request
 * takes the focus back.
 */

import * as React from "react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "@poseidon/ui/components/input-group";
import { useSidebar } from "@poseidon/ui/components/sidebar";

import {
  onFilterFocusRequest,
  requestFilterFocus,
  takeFilterFocus,
  useThreadFilter,
} from "@/components/sidebar/thread-filter";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { Search } from "@honeyicons/react";

/** Long enough to outlast the palette's exit animation and focus return. */
const SETTLE_MS = 300;

export function ThreadFilterInput() {
  const [query, setQuery] = useThreadFilter();
  const ref = React.useRef<HTMLInputElement>(null);
  const requestedAt = React.useRef(0);

  const grab = React.useCallback(() => {
    const input = ref.current;
    if (input === null) {
      return;
    }
    input.focus({ preventScroll: true });
    input.select();
  }, []);

  React.useEffect(() => {
    const claim = () => {
      if (!takeFilterFocus()) {
        return;
      }
      requestedAt.current = Date.now();
      grab();
      // The sidebar may still be sliding in, or the sheet mounting.
      requestAnimationFrame(grab);
    };
    claim();
    return onFilterFocusRequest(claim);
  }, [grab]);

  return (
    <InputGroup className="h-6 min-w-0 flex-1">
      <InputGroupAddon>
        <Search variant="bold" />
      </InputGroupAddon>
      <InputGroupInput
        ref={ref}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter threads"
        aria-label="Filter threads by title"
        className="h-6"
        onBlur={() => {
          if (Date.now() - requestedAt.current < SETTLE_MS) {
            requestAnimationFrame(grab);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          requestedAt.current = 0;
          if (query === "") {
            event.currentTarget.blur();
          } else {
            setQuery("");
          }
        }}
      />
    </InputGroup>
  );
}

/** Answers `threads.filter`: open the sidebar, then focus the field. */
export function ThreadFilterShortcut() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  useKeybindingCommand("threads.filter", () => {
    if (isMobile) {
      setOpenMobile(true);
    } else {
      setOpen(true);
    }
    requestFilterFocus();
  });
  return null;
}
