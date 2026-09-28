/**
 * The Run menu's "Edit scripts…" dialog: one row per saved script — its
 * name, its command and whether it is the primary one the Run button starts —
 * with rows to add and remove.
 *
 * The rows are a local draft, seeded once per opening (the control mounts
 * the dialog keyed per opening), so the subscribed settings document cannot
 * echo the saved list over a half-typed one. Save checks the draft
 * (`validateScripts`), shows each row's problem under it, and hands the
 * scripts up; the control writes them into the latest settings
 * (`withScripts`), keeping the setup script.
 */

import type { ProjectScript } from "@poseidon/contracts/scripts";
import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import { Input } from "@poseidon/ui/components/input";
import { Label } from "@poseidon/ui/components/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import { Add, Play, Trash } from "@honeyicons/react";

import {
  draftOf,
  scriptsFromDrafts,
  validateScripts,
  type ScriptDraft,
  type ScriptProblems,
} from "./project-scripts";

/** A row's React key, stable while its fields are typed into. */
type Row = ScriptDraft & { readonly key: number };

function ScriptRow({
  row,
  index,
  problem,
  onChange,
  onRemove,
}: {
  row: Row;
  index: number;
  problem: string | null;
  onChange: (patch: Partial<ScriptDraft>) => void;
  onRemove: () => void;
}) {
  const label = row.name.trim() === "" ? `script ${index + 1}` : row.name.trim();
  const primaryId = `script-primary-${row.key}`;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label={`Name of ${label}`}
          className="w-36 shrink-0"
          value={row.name}
          placeholder="Dev server"
          spellCheck={false}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <Input
          aria-label={`Command of ${label}`}
          value={row.command}
          placeholder="pnpm dev"
          spellCheck={false}
          onChange={(event) => onChange({ command: event.target.value })}
        />
        <Label htmlFor={primaryId} className="shrink-0">
          <Checkbox
            id={primaryId}
            checked={row.primary}
            onCheckedChange={(checked) => onChange({ primary: checked })}
          />
          Primary
        </Label>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${label}`}
                onClick={onRemove}
              />
            }
          >
            <Trash variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Remove script</TooltipContent>
        </Tooltip>
      </div>
      {problem === null ? null : <p className="text-xs text-destructive">{problem}</p>}
    </li>
  );
}

export function EditScriptsDialog({
  saved,
  open,
  onOpenChange,
  onSave,
}: {
  saved: ReadonlyArray<ProjectScript>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves true once the scripts are saved, false when they were not. */
  onSave: (scripts: ReadonlyArray<ProjectScript>) => Promise<boolean>;
}) {
  const nextKey = React.useRef(0);
  const rowOf = (draft: ScriptDraft): Row => ({ ...draft, key: nextKey.current++ });
  const [rows, setRows] = React.useState<ReadonlyArray<Row>>(() =>
    saved.map((script) => rowOf(draftOf(script))),
  );
  const [problems, setProblems] = React.useState<ScriptProblems | null>(null);
  const [saving, setSaving] = React.useState(false);

  const change = (key: number, patch: Partial<ScriptDraft>) => {
    setProblems(null);
    setRows((current) =>
      current.map((row) => {
        if (row.key === key) return { ...row, ...patch };
        // Primary is exclusive: marking one row clears the others.
        return patch.primary === true ? { ...row, primary: false } : row;
      }),
    );
  };

  const save = async () => {
    const found = validateScripts(rows);
    setProblems(found);
    if (found !== null) return;
    setSaving(true);
    const ok = await onSave(scriptsFromDrafts(rows));
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit scripts</DialogTitle>
          <DialogDescription>
            Each runs in the workspace’s root, in a new tab of the terminal drawer. The primary one
            is what the Run button starts; without one, the first is.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {rows.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Play variant="bold" />
                </EmptyMedia>
                <EmptyTitle>No scripts</EmptyTitle>
                <EmptyDescription>
                  Add one, like a dev server or the tests, to run it from the header.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row, index) => (
                <ScriptRow
                  key={row.key}
                  row={row}
                  index={index}
                  problem={problems?.[index] ?? null}
                  onChange={(patch) => change(row.key, patch)}
                  onRemove={() => {
                    setProblems(null);
                    setRows((current) => current.filter((entry) => entry.key !== row.key));
                  }}
                />
              ))}
            </ul>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((current) => [
                  ...current,
                  rowOf({ id: null, name: "", command: "", primary: current.length === 0 }),
                ])
              }
            >
              <Add variant="bold" />
              Add script
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
