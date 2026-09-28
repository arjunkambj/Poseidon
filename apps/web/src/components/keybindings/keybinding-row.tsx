/**
 * One command in the keybindings editor: its title and id, a "Modified" badge
 * when it differs from the shipped keys, and one line per binding — the chord
 * (click to record a new one), its warnings, its `when` clause and a remove
 * button — plus "Add" for another chord and a reset to the shipped keys.
 *
 * Stateless: the editor owns the draft and passes each binding's index in it
 * and what is wrong with it (`draftIssues` in `@/lib/keybinding-draft`).
 */

import { Badge } from "@poseidon/ui/components/badge";
import { Button } from "@poseidon/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@poseidon/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { KEYBINDING_CONTEXT_KEYS } from "@poseidon/client-runtime/keymap";
import type { Keybinding } from "@poseidon/contracts/settings";

import { ShortcutRecorder } from "@/components/keybindings/shortcut-recorder";
import type { BindingIssues } from "@/lib/keybinding-draft";
import { Add, AlertTriangle, Close, InfoSquare, RotateCcw } from "@honeyicons/react";

export interface RowBinding {
  readonly binding: Keybinding;
  /** The binding's index in the draft, which every edit is addressed by. */
  readonly index: number;
  readonly issues: BindingIssues;
}

export function KeybindingRow({
  command,
  title,
  bindings,
  modified,
  titleOf,
  onPatch,
  onRemove,
  onAdd,
  onReset,
}: {
  readonly command: string;
  readonly title: string;
  readonly bindings: ReadonlyArray<RowBinding>;
  readonly modified: boolean;
  /** The display name of another command, for a conflict warning. */
  readonly titleOf: (command: string) => string;
  readonly onPatch: (index: number, patch: { shortcut?: string; when?: string }) => void;
  readonly onRemove: (index: number) => void;
  readonly onAdd: (shortcut: string) => void;
  readonly onReset: () => void;
}) {
  return (
    <li className="flex flex-col gap-1.5 py-2.5" aria-label={title}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm">{title}</span>
        {title === command ? null : (
          <span className="truncate font-mono text-xs text-muted-foreground">{command}</span>
        )}
        {modified ? <Badge variant="secondary">Modified</Badge> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <ShortcutRecorder
            value=""
            label={`Add a shortcut for ${title}`}
            placeholder={
              <>
                <Add variant="bold" />
                Add
              </>
            }
            onRecord={onAdd}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  tone="muted"
                  size="icon-sm"
                  disabled={!modified}
                  aria-label={`Reset ${title} to its default keys`}
                  onClick={onReset}
                />
              }
            >
              <RotateCcw variant="bold" />
            </TooltipTrigger>
            <TooltipContent>Reset to default</TooltipContent>
          </Tooltip>
        </span>
      </div>
      {bindings.length === 0 ? (
        <span className="text-xs text-muted-foreground">Unbound</span>
      ) : (
        bindings.map((entry, position) => (
          <BindingLine
            key={`${command}-${position}`}
            title={title}
            entry={entry}
            titleOf={titleOf}
            onPatch={(patch) => onPatch(entry.index, patch)}
            onRemove={() => onRemove(entry.index)}
          />
        ))
      )}
    </li>
  );
}

function BindingLine({
  title,
  entry,
  titleOf,
  onPatch,
  onRemove,
}: {
  readonly title: string;
  readonly entry: RowBinding;
  readonly titleOf: (command: string) => string;
  readonly onPatch: (patch: { shortcut?: string; when?: string }) => void;
  readonly onRemove: () => void;
}) {
  const { binding, issues } = entry;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ShortcutRecorder value={binding.shortcut} onRecord={(shortcut) => onPatch({ shortcut })} />
      {issues.invalidShortcut ? (
        <span className="shrink-0 text-xs text-destructive">invalid chord</span>
      ) : null}
      <IssueWarning issues={issues} titleOf={titleOf} />
      <InputGroup className="min-w-0 flex-1">
        <InputGroupAddon>
          <InputGroupText>when</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput
          value={binding.when ?? ""}
          placeholder="always"
          aria-label={`When clause for ${title} on ${binding.shortcut}`}
          aria-invalid={issues.invalidWhen || undefined}
          onChange={(event) => onPatch({ when: event.target.value })}
        />
        <InputGroupAddon align="inline-end">
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupButton size="icon-xs" aria-label="Context keys a clause can use" />
              }
            >
              <InfoSquare variant="bold" />
            </TooltipTrigger>
            <TooltipContent>
              <ContextKeysHelp />
            </TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              tone="muted"
              size="icon-sm"
              aria-label={`Remove ${binding.shortcut} from ${title}`}
              onClick={onRemove}
            />
          }
        >
          <Close variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Remove this binding</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Every warning on one binding, behind a single icon; an empty slot when there is none. */
function IssueWarning({
  issues,
  titleOf,
}: {
  readonly issues: BindingIssues;
  readonly titleOf: (command: string) => string;
}) {
  const lines = [
    ...issues.conflicts.map((conflict) =>
      conflict.wins
        ? `Also bound to ${titleOf(conflict.command)} where both apply. This one fires first.`
        : `${titleOf(conflict.command)} uses these keys first where both apply, so this one does not fire there.`,
    ),
    ...(issues.reserved === null
      ? []
      : [`Reserved by the system: ${issues.reserved}. It may never reach the app.`]),
    ...(issues.invalidWhen ? ["The when clause does not parse, so this binding never fires."] : []),
  ];
  if (lines.length === 0) {
    // Holds the icon's place, so every clause field lines up.
    return <span className="size-3.5 shrink-0" />;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex size-3.5 shrink-0 text-permission" />}>
        <AlertTriangle variant="bold" className="size-3.5" />
        <span className="sr-only">{lines.join(" ")}</span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col gap-1">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** The context keys a `when` clause may name, and the operators it may use. */
function ContextKeysHelp() {
  return (
    <span className="flex flex-col gap-1">
      <span>Combine with !, &&, || and parentheses. Empty means always.</span>
      {KEYBINDING_CONTEXT_KEYS.map((key) => (
        <span key={key.name}>
          <span className="font-mono">{key.name}</span> — {key.description}
        </span>
      ))}
    </span>
  );
}
