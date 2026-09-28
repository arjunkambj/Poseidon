/**
 * The keybindings editor: one section per command area, one row per command
 * in the catalog (`@/lib/command-catalog`), and an "Other" section for rows
 * that name a command this build does not know. Each row shows the command's
 * bindings with their `when` clauses, flags a chord that collides with
 * another binding in a context that can overlap on this platform, one the
 * system owns, and an invalid chord or clause, and resets to its shipped keys.
 *
 * The draft is the table the listener resolves against — the shipped defaults
 * with the user's overrides layered on — so what the page shows is what the
 * keys do. Save posts only the difference from the defaults (`diffKeymap`)
 * through `keybindings.update`: a command left at its default stores nothing
 * and keeps following the defaults, and a command whose last binding was
 * removed is stored as unbound and stays so. The draft logic is
 * `@/lib/keybinding-draft`; one row is `@/components/keybindings/keybinding-row`.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import { cn } from "@poseidon/ui/lib/utils";
import type { Keybinding } from "@poseidon/contracts/settings";
import { detectModKey } from "@poseidon/client-runtime/keybindings";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { KeybindingRow, type RowBinding } from "@/components/keybindings/keybinding-row";
import { SettingsSection } from "@/components/Settings/settings-section";
import { useClientRuntime } from "@/lib/client-runtime";
import { COMMAND_AREAS, COMMAND_CATALOG } from "@/lib/command-catalog";
import {
  addBinding,
  commandBindings,
  draftIssues,
  draftOverrides,
  modifiedCommands,
  patchBinding,
  removeBinding,
  resetAll,
  resetCommand,
  sameDraft,
  unknownCommands,
} from "@/lib/keybinding-draft";
import { effectiveKeybindings } from "@/lib/keybindings";

const CATALOG_IDS: ReadonlySet<string> = new Set(COMMAND_CATALOG.map((entry) => entry.id));

const titleOf = (command: string): string =>
  COMMAND_CATALOG.find((entry) => entry.id === command)?.title ?? command;

type Draft = ReadonlyArray<Keybinding>;

export function KeybindingsEditor({ className }: { readonly className?: string }) {
  const { keybindingsAtom, keybindingsUpdateAtom } = useClientRuntime();
  const result = useAtomValue(keybindingsAtom);
  // The same table `@/lib/shortcuts` dispatches against.
  const serverTable = React.useMemo(
    () => effectiveKeybindings(AsyncResult.isSuccess(result) ? result.value : []),
    [result],
  );
  const update = useAtomSet(keybindingsUpdateAtom, { mode: "promise" });

  const [draft, setDraft] = React.useState<Draft>(serverTable);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);

  // Follow the server table while there is no pending edit.
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const lastServerRef = React.useRef(serverTable);
  React.useEffect(() => {
    const previous = lastServerRef.current;
    lastServerRef.current = serverTable;
    if (sameDraft(draftRef.current, previous)) {
      setDraft(serverTable);
    }
  }, [serverTable]);

  const dirty = !sameDraft(draft, serverTable);
  const modified = React.useMemo(() => modifiedCommands(draft), [draft]);
  const overrideCount = modified.size;
  const issues = React.useMemo(() => draftIssues(draft, detectModKey()), [draft]);

  const rowsFor = (command: string): ReadonlyArray<RowBinding> =>
    commandBindings(draft, command).map(({ binding, index }) => ({
      binding,
      index,
      issues: issues[index]!,
    }));

  const save = () => {
    setSaving(true);
    setError(null);
    void update(draftOverrides(draft)).then(
      () => setSaving(false),
      () => {
        setSaving(false);
        setError("the server rejected the keybinding table");
      },
    );
  };

  const row = (command: string, title: string) => (
    <KeybindingRow
      key={command}
      command={command}
      title={title}
      bindings={rowsFor(command)}
      modified={modified.has(command)}
      titleOf={titleOf}
      onPatch={(index, patch) => setDraft((current) => patchBinding(current, index, patch))}
      onRemove={(index) => setDraft((current) => removeBinding(current, index))}
      onAdd={(shortcut) => setDraft((current) => addBinding(current, command, shortcut))}
      onReset={() => setDraft((current) => resetCommand(current, command))}
    />
  );

  const other = unknownCommands(draft, CATALOG_IDS);

  return (
    <TooltipProvider>
      <section className={cn("flex min-w-0 flex-col gap-6", className)} aria-label="Keybindings">
        {/* No heading of its own: the page above it names the section, and the
            `aria-label` on the section covers the dev fixture that mounts it
            without one. */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {overrideCount === 0
              ? "Every command is on its default keys."
              : `${overrideCount} ${overrideCount === 1 ? "command differs" : "commands differ"} from the defaults.`}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {dirty ? <span className="text-xs text-muted-foreground">unsaved</span> : null}
            <Button
              size="sm"
              variant="ghost"
              tone="muted"
              disabled={saving || overrideCount === 0}
              onClick={() => setConfirmReset(true)}
            >
              Reset all
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!dirty || saving}
              onClick={() => setDraft(serverTable)}
            >
              Revert
            </Button>
            <Button size="sm" disabled={!dirty || saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </span>
        </div>
        {error === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {COMMAND_AREAS.map((area) => (
          <EditorSection key={area} heading={area}>
            {COMMAND_CATALOG.filter((entry) => entry.area === area).map((entry) =>
              row(entry.id, entry.title),
            )}
          </EditorSection>
        ))}
        {other.length === 0 ? null : (
          <EditorSection
            heading="Other"
            description="Bindings for commands this version does not have. They do nothing until one answers them."
          >
            {other.map((command) => row(command, command))}
          </EditorSection>
        )}
        <ConfirmDialog
          open={confirmReset}
          onOpenChange={setConfirmReset}
          title="Reset every keybinding?"
          description="Every command goes back to its default keys and your own bindings are dropped. Nothing is stored until you save, and Revert undoes it."
          confirmLabel="Reset all"
          onConfirm={() => setDraft(resetAll())}
        />
      </section>
    </TooltipProvider>
  );
}

function EditorSection({
  heading,
  description,
  children,
}: {
  readonly heading: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <SettingsSection title={heading} description={description}>
      <ul className="flex flex-col divide-y">{children}</ul>
    </SettingsSection>
  );
}
