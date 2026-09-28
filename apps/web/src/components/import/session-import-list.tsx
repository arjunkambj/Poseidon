/**
 * The sessions Settings → Import can bring in, grouped by the folder they ran
 * in. A row the user can import has a checkbox; one a thread already holds
 * links to that thread instead; a failed one says why and offers Retry. The
 * list only draws: the selection, the row states and the runner live in
 * `SessionImportPanel`, the grouping and the states in `@/lib/session-import`.
 */

import { Link } from "@tanstack/react-router";

import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import type { ImportableSessionEntry } from "@poseidon/contracts/sessionImport";

import { HarnessAvatar } from "@/components/harness-avatar";
import { relativeTime } from "@/lib/format";
import { harnessMonograms } from "@/lib/harness-monogram";
import {
  isSelectable,
  rowState,
  sessionKey,
  type RowState,
  type SessionGroup,
} from "@/lib/session-import";
import { Refresh, Spinner } from "@honeyicons/react";

import { SettingsSection } from "@/components/Settings/settings-section";

function RowStatus({
  state,
  title,
  onRetry,
}: {
  readonly state: RowState;
  readonly title: string;
  readonly onRetry: () => void;
}) {
  switch (state.status) {
    case "idle":
      return null;
    case "queued":
      return <span className="shrink-0 text-xs text-muted-foreground">Queued</span>;
    case "importing":
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner variant="bold" />
          Importing
        </span>
      );
    case "imported":
      return (
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/t/$threadId" params={{ threadId: state.threadId }} />}
          aria-label={`Open ${title}`}
        >
          Open
        </Button>
      );
    case "failed":
      return (
        <Button variant="outline" size="sm" aria-label={`Retry ${title}`} onClick={onRetry}>
          <Refresh variant="bold" />
          Retry
        </Button>
      );
  }
}

function SessionRow({
  entry,
  state,
  selected,
  monogram,
  now,
  onSelect,
  onRetry,
}: {
  readonly entry: ImportableSessionEntry;
  readonly state: RowState;
  readonly selected: boolean;
  readonly monogram: string;
  readonly now: number;
  readonly onSelect: (next: boolean) => void;
  readonly onRetry: () => void;
}) {
  const details = [
    entry.connectorName,
    entry.messageCount === undefined
      ? null
      : `${entry.messageCount} message${entry.messageCount === 1 ? "" : "s"}`,
    relativeTime(now, entry.updatedAt),
  ].filter((part) => part !== null && part !== "");

  return (
    <div className="flex items-center gap-3 py-1.5" data-slot="session-row">
      {/* An imported row keeps the checkbox's width, so titles line up. */}
      <span className="flex size-4 shrink-0 items-center justify-center">
        {state.status === "imported" ? null : (
          <Checkbox
            checked={selected && isSelectable(state)}
            disabled={!isSelectable(state)}
            aria-label={`Select ${entry.title}`}
            onCheckedChange={(next) => onSelect(next)}
          />
        )}
      </span>
      <HarnessAvatar monogram={monogram} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{entry.title}</span>
        <span className="truncate text-xs text-muted-foreground">{details.join(" · ")}</span>
        {state.status === "failed" ? (
          <span className="text-xs text-destructive">{state.message}</span>
        ) : null}
      </div>
      <RowStatus state={state} title={entry.title} onRetry={onRetry} />
    </div>
  );
}

export function SessionImportList({
  groups,
  states,
  selected,
  monograms,
  now,
  onSelect,
  onRetry,
}: {
  readonly groups: ReadonlyArray<SessionGroup>;
  readonly states: ReadonlyMap<string, RowState>;
  readonly selected: ReadonlySet<string>;
  /** Each connector instance's monogram, by instance id. */
  readonly monograms: ReadonlyMap<string, string>;
  readonly now: number;
  readonly onSelect: (key: string, next: boolean) => void;
  readonly onRetry: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <SettingsSection
          key={group.cwd}
          title={group.name}
          description={
            <span className="block truncate" title={group.cwd}>
              {group.projectId === null ? "New project · " : "Project open · "}
              {group.cwd}
            </span>
          }
        >
          {group.entries.map((entry) => {
            const key = sessionKey(entry);
            return (
              <SessionRow
                key={key}
                entry={entry}
                state={rowState(entry, states)}
                selected={selected.has(key)}
                monogram={
                  monograms.get(entry.connectorInstanceId) ??
                  harnessMonograms([entry.connectorName])[0] ??
                  ""
                }
                now={now}
                onSelect={(next) => onSelect(key, next)}
                onRetry={() => onRetry(key)}
              />
            );
          })}
        </SettingsSection>
      ))}
    </div>
  );
}
