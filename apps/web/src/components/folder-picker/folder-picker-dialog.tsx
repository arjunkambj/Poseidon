/**
 * Choose a folder on the machine the server runs on.
 *
 * The desktop shell has a native dialog and keeps it; this is what everywhere
 * else gets — a browser tab today, a client that is not on this machine later.
 * It reads `fs.browse` through `fsAtoms` like every other surface reads its
 * atoms, so it shares the app's one socket and relists by itself after a
 * reconnect.
 *
 * Deliberately plain: a path field, a breadcrumb, the subfolders, a hidden
 * toggle and one button that returns the current directory. No preview, no
 * multi-select, no favourites — the answer this produces is a single absolute
 * path, and everything that happens to it afterwards is the caller's existing
 * validation and create path.
 *
 * Mount it only while it is open. Every piece of its state — where it opens,
 * the cursor, the hidden toggle — is seeded on the first render, and its
 * listing atom subscribes as soon as it exists; a kept-alive instance would
 * open on the directory of the *previous* visit and would read a directory on
 * the server before anyone had clicked anything.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { FsQuery } from "@poseidon/client-runtime/fsAtoms";
import type { FsEntry, FsListing } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import { Input } from "@poseidon/ui/components/input";
import { Label } from "@poseidon/ui/components/label";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useConnectionState } from "@/state/hooks";
import { DialogActions } from "@/components/dialog-actions";
import { DialogBody } from "@/components/dialog-body";

import { Breadcrumb, FolderList, FolderListMessage } from "./folder-list";
import { useFsAtoms } from "./fs-atoms";
import {
  completionsFor,
  confirmAction,
  cursorOn,
  fieldValue,
  highlighted,
  initialLocation,
  movedCursor,
  movedTo,
  pickerKeyAction,
  typed,
  type PickerLocation,
} from "./picker-state";
import { AlertTriangle, Folder, Repeat, Spinner, WifiOff } from "@honeyicons/react";

export function FolderPickerDialog({
  open,
  onOpenChange,
  initialPath,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** What the caller's field already held; an absolute path opens there. */
  readonly initialPath: string;
  /** The chosen directory, in the server's own spelling of it. */
  readonly onPick: (path: string) => void;
}) {
  const atoms = useFsAtoms();
  const connected = useConnectionState().status === "connected";
  const [showHidden, setShowHidden] = React.useState(false);
  const [location, setLocation] = React.useState<PickerLocation>(() =>
    initialLocation(initialPath),
  );

  const browseAtom = atoms.directoryAtom({ path: location.path, showHidden });
  const result = useAtomValue(browseAtom);
  const retry = useAtomRefresh(browseAtom);

  // A stream that ended is the same news as a failed call, and the same button
  // fixes both: the atom's own failure channel never carries a server reason.
  const query: FsQuery | null = AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result)
      ? { _tag: "error", reason: "internal", message: "That folder could not be listed." }
      : null;
  const listing: FsListing | null = query?._tag === "ok" ? query.listing : null;

  // The last directory that listed, kept for the breadcrumb alone. A refused
  // path would otherwise take the whole trail with it, leaving the error state
  // with no way out but retyping — and "up" is exactly the way out of it.
  const lastListed = React.useRef<FsListing | null>(null);
  if (listing !== null) {
    lastListed.current = listing;
  }
  const trail = listing ?? lastListed.current;

  const draft = fieldValue(location, listing);
  const completions = completionsFor(location.draft, listing);
  const entries = listing?.entries ?? [];
  const confirm = confirmAction(location, listing);

  const goTo = (path: string) => setLocation(movedTo(path));
  const parent = trail === null ? null : trail.parent;
  const goUp = () => {
    if (parent !== null) {
      goTo(parent);
    }
  };
  const descend = () => {
    const entry = highlighted(location, listing);
    if (entry !== null) {
      goTo(entry.path);
    }
  };
  const navigateTyped = () => {
    const wanted = draft.trim();
    if (wanted !== "") {
      goTo(wanted);
    }
  };

  const handleKey = (event: React.KeyboardEvent, inPathField: boolean) => {
    const action = pickerKeyAction({
      key: event.key,
      inPathField,
      draftEmpty: draft === "",
    });
    if (action === null) {
      return;
    }
    event.preventDefault();
    switch (action) {
      case "cursor-up":
        setLocation((current) => movedCursor(current, -1, entries.length));
        return;
      case "cursor-down":
        setLocation((current) => movedCursor(current, 1, entries.length));
        return;
      case "descend":
        descend();
        return;
      case "up":
        goUp();
        return;
      case "navigate-typed":
        navigateTyped();
    }
  };

  const openEntry = (entry: FsEntry) => goTo(entry.path);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* One track no wider than the panel: an auto track grows to the
          breadcrumb's full width on a deep path and spills out of it. */}
      <DialogContent className="grid-cols-1">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            Folders on the machine the server runs on. Enter opens the highlighted one; Backspace
            goes up.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="folder-picker-path">Path</Label>
            <Input
              id="folder-picker-path"
              value={draft}
              placeholder="/Users/you/code"
              autoFocus
              spellCheck={false}
              onChange={(event) => setLocation((current) => typed(current, event.target.value))}
              onKeyDown={(event) => handleKey(event, true)}
            />
            {completions.length === 0 ? null : (
              <div className="flex flex-wrap gap-1">
                {completions.slice(0, 8).map((entry) => (
                  <Button
                    key={entry.path}
                    type="button"
                    variant="secondary"
                    tone="muted"
                    size="xs"
                    onClick={() => goTo(entry.path)}
                  >
                    {entry.name}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <Breadcrumb
            path={trail?.path ?? null}
            canGoUp={parent !== null}
            onGoUp={goUp}
            onNavigate={goTo}
          />

          {!connected ? (
            <FolderListMessage icon={WifiOff} text="Not connected to the server." />
          ) : query === null ? (
            <FolderListMessage icon={Spinner} text="Listing…" />
          ) : query._tag === "error" ? (
            <FolderListMessage
              icon={AlertTriangle}
              text={query.message}
              action={
                <Button type="button" variant="ghost" size="sm" onClick={retry}>
                  <Repeat variant="bold" />
                  Try again
                </Button>
              }
            />
          ) : entries.length === 0 ? (
            <FolderListMessage icon={Folder} text="No folders in here." />
          ) : (
            <FolderList
              entries={entries}
              cursor={location.cursor}
              idPrefix="folder-picker-entry"
              onSelect={(index) =>
                setLocation((current) => cursorOn(current, index, entries.length))
              }
              onOpen={openEntry}
              onKeyDown={(event) => handleKey(event, false)}
            />
          )}

          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 type-micro text-muted-foreground">
              <Checkbox
                checked={showHidden}
                onCheckedChange={(checked) => setShowHidden(checked === true)}
                aria-label="Show hidden folders"
              />
              Show hidden folders
            </label>
            {listing?.truncated === true ? (
              <span className="type-micro text-muted-foreground">
                First folders only — this one holds more.
              </span>
            ) : null}
          </div>
        </DialogBody>

        <DialogActions>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* A path still sitting in the field is what the user means, not the
              directory that was listed before they typed it — so this browses
              there first and only confirms what is actually on screen. */}
          <Button
            type="button"
            disabled={confirm.kind === "none"}
            onClick={() => {
              if (confirm.kind === "navigate") {
                goTo(confirm.path);
                return;
              }
              if (confirm.kind === "pick") {
                onPick(confirm.path);
                onOpenChange(false);
              }
            }}
          >
            {confirm.kind === "navigate" ? "Go to this folder" : "Use this folder"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
