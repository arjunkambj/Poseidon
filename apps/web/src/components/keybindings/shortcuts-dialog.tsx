/**
 * The keyboard shortcuts sheet (`shortcuts.open`, Mod+/ by default): every
 * command in the catalog grouped by area, with the chords the live table binds
 * to it — the user's overrides applied, "unbound" when there are none — and
 * the `when` clause each is scoped to, plus the composer's fixed keys.
 * Searchable by name, id or key (`@/lib/cheatsheet`).
 *
 * Mounted once at the app root, so the chord works on every route. The
 * palette offers it through the catalog's General group, and Settings →
 * Keybindings opens it by dispatching the same command.
 */

import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@poseidon/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@poseidon/ui/components/input-group";
import { detectModKey } from "@poseidon/client-runtime/keybindings";

import { DialogBody } from "@/components/dialog-body";
import { cheatsheetSections, type CheatsheetRow } from "@/lib/cheatsheet";
import { COMMAND_CATALOG } from "@/lib/command-catalog";
import { Keycaps, useKeybindingCommand, useKeybindings } from "@/lib/shortcuts";
import { Search } from "@honeyicons/react";

export function ShortcutsDialog() {
  const [open, setOpen] = React.useState(false);
  useKeybindingCommand("shortcuts.open", () => setOpen((current) => !current));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <ShortcutsSheet onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** The sheet itself. It mounts on every open, so the search starts empty. */
function ShortcutsSheet({ onClose }: { readonly onClose: () => void }) {
  const [query, setQuery] = React.useState("");
  const keybindings = useKeybindings();
  const modKey = detectModKey();
  const sections = React.useMemo(
    () => cheatsheetSections(COMMAND_CATALOG, keybindings, query, modKey),
    [keybindings, query, modKey],
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Your own bindings included. Change them in{" "}
          <Link to="/settings/keybindings" onClick={onClose}>
            Settings → Keybindings
          </Link>
          .
        </DialogDescription>
      </DialogHeader>
      <InputGroup>
        <InputGroupAddon>
          <Search variant="bold" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or key…"
          aria-label="Search shortcuts"
        />
      </InputGroup>
      <DialogBody className="max-h-96">
        {sections.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No shortcut matches</EmptyTitle>
              <EmptyDescription>Try a command name, or keys such as “mod+k”.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          sections.map((section) => (
            <section key={section.area} aria-label={section.area} className="pb-3">
              <h3 className="py-1.5 text-xs font-medium text-muted-foreground">{section.area}</h3>
              <ul className="flex flex-col">
                {section.rows.map((row) => (
                  <SheetRow key={row.id} row={row} />
                ))}
              </ul>
            </section>
          ))
        )}
      </DialogBody>
    </>
  );
}

function SheetRow({ row }: { readonly row: CheatsheetRow }) {
  return (
    <li className="flex items-start justify-between gap-4 py-1.5">
      <span className="flex min-w-0 flex-col">
        <span>{row.title}</span>
        {row.when.map((when) => (
          <span key={when} className="font-mono text-xs break-words text-muted-foreground">
            when {when}
          </span>
        ))}
      </span>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {row.chords.length === 0 ? (
          <span className="text-xs text-muted-foreground">unbound</span>
        ) : (
          row.chords.map((chord) => <Keycaps key={chord.shortcut} caps={chord.caps} />)
        )}
      </span>
    </li>
  );
}
