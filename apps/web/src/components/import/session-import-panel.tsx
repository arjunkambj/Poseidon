/**
 * Importing harness sessions: the list `sessions.importable` answers, the
 * selection, and a run that imports the selected rows one at a time.
 *
 * The list loads when this mounts and is not read anywhere else, so opening
 * the page is what reads the harnesses' session files. A run keeps going
 * past a failed row, which keeps its message and a Retry; Stop lets the row
 * in flight finish and puts the queued ones back. Closing the page, or the
 * setup dialog holding it, stops the run the same way, and a toast says how
 * many sessions that left out, since nothing on screen is left to. Rows a thread already holds link to it; `onOpenThread`
 * runs as one is followed, for a dialog to close so the thread shows.
 */

import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@poseidon/ui/components/button";

import { useConnectorIconKeys } from "@/components/ui/icons/use-connector-icon-keys";
import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { catalogMonograms } from "@/lib/harness-monogram";
import {
  groupSessions,
  isSelectable,
  rowState,
  runImports,
  sessionKey,
  type ImportOutcome,
  type ImportRun,
  type RowState,
} from "@/lib/session-import";
import { useNow } from "@/lib/use-now";
import { Import, Spinner, Stop } from "@honeyicons/react";

import { SessionImportList } from "./session-import-list";

const MINUTE = 60_000;

export function SessionImportPanel({
  onOpenThread,
}: {
  readonly onOpenThread?: (() => void) | undefined;
} = {}) {
  const atoms = useAppAtoms();
  const listResult = useAtomValue(atoms.importableSessionsAtom);
  const reload = useAtomRefresh(atoms.importableSessionsAtom);
  const connectors = AsyncResult.getOrElse(useAtomValue(atoms.connectorsAtom), () => []);
  const importSession = useAtomSet(atoms.importSessionAtom, { mode: "promiseExit" });
  const now = useNow(MINUTE);
  const iconKeys = useConnectorIconKeys();

  const [states, setStates] = React.useState<ReadonlyMap<string, RowState>>(new Map());
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = React.useState(false);
  const runRef = React.useRef<ImportRun | null>(null);

  // Leaving the page stops the run after the row in flight, and says so.
  React.useEffect(
    () => () => {
      const left = runRef.current?.stop() ?? 0;
      if (left > 0) {
        toast(`Stopped importing: ${left} session${left === 1 ? " was" : "s were"} not imported`, {
          description: "Settings → Import lists them.",
        });
      }
    },
    [],
  );

  const entries = React.useMemo(
    () => (AsyncResult.isSuccess(listResult) ? listResult.value : []),
    [listResult],
  );
  const groups = React.useMemo(() => groupSessions(entries), [entries]);
  const byKey = React.useMemo(
    () => new Map(entries.map((entry) => [sessionKey(entry), entry])),
    [entries],
  );
  const monograms = React.useMemo(
    () =>
      catalogMonograms(
        connectors
          .filter((connector) => connector.enabled)
          .map((connector) => ({ connector, models: [] })),
      ),
    [connectors],
  );

  // In the order on screen, so a run goes down the page.
  const selectable = groups
    .flatMap((group) => group.entries)
    .filter((entry) => isSelectable(rowState(entry, states)));
  const picked = selectable.map(sessionKey).filter((key) => selected.has(key));

  const setState = (key: string, state: RowState) =>
    setStates((current) => new Map(current).set(key, state));

  const importOne = async (key: string): Promise<ImportOutcome> => {
    const entry = byKey.get(key);
    if (entry === undefined) {
      return { ok: false, message: "The session is no longer listed." };
    }
    const exit = await importSession({
      connectorInstanceId: entry.connectorInstanceId,
      sourceId: entry.sourceId,
    });
    return Exit.isSuccess(exit)
      ? { ok: true, threadId: exit.value.threadId }
      : { ok: false, message: describeExitError(exit, "The session was not imported.") };
  };

  const start = (keys: ReadonlyArray<string>) => {
    if (keys.length === 0) return;
    setSelected((current) => new Set([...current].filter((key) => !keys.includes(key))));
    const run = runImports(keys, importOne, setState);
    runRef.current = run;
    setRunning(true);
    void run.done.finally(() => {
      if (runRef.current === run) {
        runRef.current = null;
        setRunning(false);
      }
      // An import can add a project on a group's folder; the list says so.
      reload();
    });
  };

  // A Retry runs beside a batch in flight; the server takes them in turn.
  const retry = (key: string) => void runImports([key], importOne, setState).done.finally(reload);

  const toggle = (key: string, next: boolean) =>
    setSelected((current) => {
      const updated = new Set(current);
      if (next) updated.add(key);
      else updated.delete(key);
      return updated;
    });

  if (!AsyncResult.isSuccess(listResult)) {
    return AsyncResult.isFailure(listResult) ? (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-destructive">The sessions could not be listed.</span>
        <Button variant="outline" size="sm" onClick={reload}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner variant="bold" />
        Looking for sessions…
      </p>
    );
  }

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sessions found. Sessions you run in a harness outside Poseidon show up here.
      </p>
    );
  }

  const allPicked = selectable.length > 0 && picked.length === selectable.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm text-muted-foreground">
          {picked.length === 0 ? "Select sessions to import." : `${picked.length} selected`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={selectable.length === 0}
          onClick={() =>
            setSelected(
              allPicked ? new Set() : new Set(selectable.map((entry) => sessionKey(entry))),
            )
          }
        >
          {allPicked ? "Select none" : "Select all"}
        </Button>
        {running ? (
          <Button variant="outline" size="sm" onClick={() => runRef.current?.stop()}>
            <Stop variant="bold" />
            Stop
          </Button>
        ) : null}
        <Button size="sm" disabled={running || picked.length === 0} onClick={() => start(picked)}>
          <Import variant="bold" />
          Import selected
        </Button>
      </div>
      <SessionImportList
        groups={groups}
        states={states}
        selected={selected}
        monograms={monograms}
        iconKeys={iconKeys}
        now={now}
        onSelect={toggle}
        onRetry={retry}
        onOpen={onOpenThread}
      />
    </div>
  );
}
