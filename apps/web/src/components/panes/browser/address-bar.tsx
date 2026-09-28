/**
 * The pane's toolbar: back/forward/reload — stop while the page loads — as
 * human gestures (each bumps the epoch, so they interrupt an in-flight agent
 * call), an address field that mirrors the live url and navigates on Enter,
 * and the status chip that shows who is driving — `agent: browser_click`
 * while a `browser_*` call runs. What is typed goes through `./address`: only
 * an http(s) url or `about:blank` is ever loaded.
 *
 * Focusing the field opens its suggestions (`./address-suggestions`): the
 * project's running dev servers and the pages its tabs visited. The arrow
 * keys highlight one, and Enter loads it instead of what was typed.
 */
import * as React from "react";

import type { BrowserHumanInput, BrowserState } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { Input } from "@poseidon/ui/components/input";

import { cn } from "@/lib/utils";
import { normalizeAddress } from "./address";
import { AddressSuggestions } from "./address-suggestions";
import { browserStatus, browserStatusVisible } from "./status";
import { moveActive, suggestionsFor } from "./suggestions";
import type { SuggestionSource } from "./use-suggestions";
import { ChevronLeft, ChevronRight, Repeat, Stop } from "@honeyicons/react";

/** What the in-app pane knows about the selected tab's history. */
export interface TabNavigation {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
}

export interface AddressBarProps {
  readonly state: BrowserState | null;
  /**
   * The url to show when the pane knows it better than the server does — the
   * in-app pane's selected tab. Absent, the server's url is shown.
   */
  readonly url?: string | undefined;
  /** The selected tab's history, in-app; absent, every button is live. */
  readonly nav?: TabNavigation | undefined;
  readonly onAction: (input: BrowserHumanInput) => void;
  /** The address field, for `browser.focusUrl`. */
  readonly inputRef?: React.RefObject<HTMLInputElement | null>;
  /** The dev servers and history the field suggests; absent, it suggests nothing. */
  readonly suggest?: SuggestionSource | undefined;
  /** Trailing controls: the in-app pane's zoom and "more" menu. */
  readonly children?: React.ReactNode;
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const NO_SOURCE: SuggestionSource = { servers: [], history: [], refresh: () => undefined };

export function AddressBar({
  state,
  url,
  nav,
  onAction,
  inputRef,
  suggest = NO_SOURCE,
  children,
}: AddressBarProps) {
  const [draft, setDraft] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [listOpen, setListOpen] = React.useState(false);
  const [active, setActive] = React.useState<string | null>(null);
  const ownRef = React.useRef<HTMLInputElement | null>(null);
  const fieldRef = inputRef ?? ownRef;
  const displayUrl = url ?? state?.url ?? "";
  const status = browserStatus(state);
  const suggestions = listOpen
    ? suggestionsFor(draft, displayUrl, suggest.servers, suggest.history)
    : [];

  const openList = () => {
    if (!listOpen) suggest.refresh();
    setListOpen(true);
  };
  const closeList = () => {
    setListOpen(false);
    setActive(null);
  };

  // The address mirrors the live url unless the human is mid-edit.
  React.useEffect(() => {
    if (!editing) setDraft(displayUrl);
  }, [displayUrl, editing]);

  const submit = () => {
    const value = active ?? draft.trim();
    closeList();
    if (value === "" || value === displayUrl) {
      setEditing(false);
      return;
    }
    const target = normalizeAddress(value);
    if (target !== null) onAction({ kind: "navigate", url: target });
    setEditing(false);
  };

  const pick = (picked: string) => {
    closeList();
    setEditing(false);
    if (picked !== displayUrl) onAction({ kind: "navigate", url: picked });
    fieldRef.current?.blur();
  };

  const history = (direction: "back" | "forward" | "reload" | "stop") => () =>
    onAction({ kind: "history", direction });

  return (
    <div className="flex items-center gap-1.5 px-2 pb-1.5">
      <ToolbarButton label="Back" disabled={nav?.canGoBack === false} onClick={history("back")}>
        <ChevronLeft variant="bold" />
      </ToolbarButton>
      <ToolbarButton
        label="Forward"
        disabled={nav?.canGoForward === false}
        onClick={history("forward")}
      >
        <ChevronRight variant="bold" />
      </ToolbarButton>
      {nav?.loading === true ? (
        <ToolbarButton label="Stop" onClick={history("stop")}>
          <Stop variant="bold" />
        </ToolbarButton>
      ) : (
        <ToolbarButton label="Reload" onClick={history("reload")}>
          <Repeat variant="bold" />
        </ToolbarButton>
      )}
      <AddressSuggestions
        open={listOpen}
        suggestions={suggestions}
        active={active}
        onActiveChange={setActive}
        onPick={pick}
        onDismiss={closeList}
      >
        <Input
          ref={fieldRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setEditing(true);
            setActive(null);
            openList();
          }}
          onBlur={() => {
            setEditing(false);
            closeList();
          }}
          onFocus={(event) => {
            setEditing(true);
            openList();
            event.currentTarget.select();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!listOpen) openList();
              else
                setActive(
                  moveActive(suggestions, active, event.key === "ArrowDown" ? "down" : "up"),
                );
            }
            if (event.key === "Enter") submit();
            if (event.key === "Escape") {
              if (listOpen && suggestions.length > 0) {
                closeList();
                return;
              }
              setDraft(displayUrl);
              setEditing(false);
            }
          }}
          placeholder="Search or enter address"
          spellCheck={false}
          className="h-7 flex-1"
          aria-label="Address"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
        />
      </AddressSuggestions>
      {browserStatusVisible(state) ? (
        <div
          className="text-muted-foreground flex max-w-[40%] items-center gap-1.5 truncate px-1 text-xs"
          title={status.label}
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
          <span className="truncate">{status.label}</span>
        </div>
      ) : null}
      {children}
    </div>
  );
}
