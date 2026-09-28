import * as React from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { Button } from "@poseidon/ui/components/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@poseidon/ui/components/command";
import { Kbd, KbdGroup } from "@poseidon/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { PaletteCommands } from "@/components/Layout/palette-commands";
import {
  NavigationGroup,
  NewThreadGroup,
  SettingsGroup,
  ThreadsGroup,
} from "@/components/Layout/palette-groups";
import { MessageHitsGroup } from "@/components/Layout/palette-message-hits";
import { paletteFilter, paletteQuery } from "@/lib/palette-query";
import { CommandKbd, useKeybindingCommand } from "@/lib/shortcuts";
import { Search as SearchIcon } from "@honeyicons/react";

type SearchContextValue = {
  setOpen: (open: boolean) => void;
};

const SearchContext = React.createContext<SearchContextValue | null>(null);

/**
 * The palette handle. Deliberately not exported: `SearchProvider` claims
 * `commandPalette.toggle` itself, so no surface outside this file needs to
 * reach in and open the palette.
 */
function useSearch() {
  const context = React.useContext(SearchContext);
  if (!context) {
    throw new Error("useSearch must be used within a SearchProvider.");
  }
  return context;
}

/**
 * Mounted once at the app root, not inside a layout: these commands are
 * route-independent, and while they were claimed inside `HomeLayout` the
 * palette, New task and Settings chords all did nothing on `/settings/*`.
 * The same goes for Skills and MCP servers, which open their Customize pages.
 * `sidebar.toggle` is the exception — it belongs to whichever
 * sidebar is on screen, so each layout claims it through
 * `SidebarToggleShortcut` and this file only *fires* it.
 */
export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const value = React.useMemo(() => ({ setOpen }), []);

  // Handlers only — the chords come from the settings-owned keybinding table
  // and the one listener above the routes (@/lib/shortcuts). The palette is a
  // modal dialog over the route, so every navigating handler closes it first.
  const go = React.useCallback(
    (to: "/" | "/customize/skills" | "/customize/mcp" | "/settings") => () => {
      setOpen(false);
      void navigate({ to });
    },
    [navigate],
  );

  // A chord pressed with the palette open — Mod+1 on a thread row's hint,
  // Mod+Shift+] — can move the route under it; the palette closes with it.
  const pathname = useLocation({ select: (location) => location.pathname });
  React.useEffect(() => setOpen(false), [pathname]);

  useKeybindingCommand("commandPalette.toggle", () => setOpen((current) => !current));
  useKeybindingCommand("thread.new", go("/"));
  useKeybindingCommand("skills.open", go("/customize/skills"));
  useKeybindingCommand("mcp.open", go("/customize/mcp"));
  useKeybindingCommand("settings.open", go("/settings"));

  return (
    <SearchContext.Provider value={value}>
      {children}
      <SearchDialog open={open} onOpenChange={setOpen} />
    </SearchContext.Provider>
  );
}

export function SearchTrigger({ className }: { className?: string }) {
  const { setOpen } = useSearch();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={className}
            onClick={() => setOpen(true)}
          />
        }
      >
        <SearchIcon variant="bold" />
        <span className="sr-only">Search</span>
      </TooltipTrigger>
      <TooltipContent>
        Search
        <CommandKbd command="commandPalette.toggle" />
      </TooltipContent>
    </Tooltip>
  );
}

function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search">
      <PaletteContent onDone={() => onOpenChange(false)} />
    </CommandDialog>
  );
}

/**
 * The palette itself. It mounts on every open, so the input starts empty each
 * time. A leading ">" narrows it to commands: the thread list steps aside and
 * the entries match against the text after the ">" (@/lib/palette-query).
 */
function PaletteContent({ onDone }: { onDone: () => void }) {
  const [search, setSearch] = React.useState("");
  const { commandsOnly } = paletteQuery(search);

  return (
    <Command filter={paletteFilter}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search threads and messages, or type > for commands…"
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <NavigationGroup onDone={onDone} />
        <NewThreadGroup onDone={onDone} />
        <PaletteCommands onDone={onDone} />
        <SettingsGroup onDone={onDone} />
        {commandsOnly ? null : <ThreadsGroup onDone={onDone} />}
        {commandsOnly ? null : <MessageHitsGroup search={search} onDone={onDone} />}
      </CommandList>
      <div className="-mx-1 -mb-1 mt-1 flex items-center gap-3 border-t px-3 py-2 type-micro text-muted-foreground">
        <KeyHint keys={["↑", "↓"]} label="navigate" />
        <KeyHint keys={["↵"]} label="open" />
        <KeyHint keys={["esc"]} label="close" />
        <KeyHint keys={[">"]} label="commands" />
      </div>
    </Command>
  );
}

function KeyHint({ keys, label }: { keys: ReadonlyArray<string>; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <KbdGroup>
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
      {label}
    </span>
  );
}
