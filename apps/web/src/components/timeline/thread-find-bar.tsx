/**
 * The find bar over the timeline's top-right corner: a stock `InputGroup`
 * like the terminal's find (`terminal-find.tsx`). Enter steps to the next
 * match, Shift+Enter to the previous one, and Escape closes it — the state and
 * the scroll live in `useThreadFind`.
 *
 * The step buttons stay enabled without matches, where they do nothing: a
 * disabled control dims the whole stock input group.
 *
 * Escape is taken here with `preventDefault`, so the global listener skips it
 * and it never reaches `thread.interrupt` or an approval's Escape.
 */

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@poseidon/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import type { ThreadFind } from "@/components/timeline/use-thread-find";
import { ChevronDown, ChevronUp, Close, Search } from "@honeyicons/react";

function FindButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<InputGroupButton size="icon-xs" aria-label={label} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ThreadFindBar({ find }: { find: ThreadFind }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  // `timeline.find` while open puts the focus back here with the query selected.
  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [find.focusKey]);

  return (
    <div
      className="absolute top-2 right-4 z-10 w-72 rounded-lg bg-background shadow-md"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          find.close();
        }
      }}
    >
      <InputGroup>
        <InputGroupAddon>
          <Search variant="bold" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          aria-label="Find in thread"
          placeholder="Find"
          value={find.query}
          onChange={(event) => find.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              find.step(event.shiftKey ? "previous" : "next");
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          {find.searching ? (
            <InputGroupText aria-live="polite">{`${find.index + 1}/${find.count}`}</InputGroupText>
          ) : null}
          <FindButton label="Previous match" onClick={() => find.step("previous")}>
            <ChevronUp variant="bold" />
          </FindButton>
          <FindButton label="Next match" onClick={() => find.step("next")}>
            <ChevronDown variant="bold" />
          </FindButton>
          <FindButton label="Close find" onClick={find.close}>
            <Close variant="bold" />
          </FindButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
