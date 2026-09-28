/**
 * The terminal drawer, at the bottom of the thread column — or of the New
 * task page's column, before any thread exists. `./owned-terminal` mounts it
 * for a thread, a project or home (`TerminalOwner`) while that owner's drawer
 * is open, and answers `terminal.toggle`.
 *
 * The drawer holds a tab strip over a lazily loaded xterm (`./terminal-view`)
 * for the tab in front, a fresh one per tab, and a toolbar that acts on that
 * xterm — "Add selection to chat" quotes its selection into the composer draft
 * on screen (`draftId`), and Find (`./terminal-find`) searches the xterm's
 * output. A mod-clicked link goes to `onOpenLink`, a printed file reference
 * to `fileLinks`. While the tab in front is a running script that printed a
 * dev server, "Open in browser" (`./dev-server-button`) opens it through
 * `onOpenDevServer`. A drawer with no composer (home's) passes no `draftId`,
 * `fileLinks` or `onOpenDevServer`, and shows none of what they drive.
 *
 * Which terminals exist is the server's to say: the drawer folds each
 * `terminal.list` into its tab state (`./drawer-state`). Opening a drawer that
 * has none starts one, at the grid the xterm measured, and closing the last
 * tab hides the drawer — an open drawer with nothing in it has no use.
 *
 * The root carries `data-context="terminal"`, which is what makes the app's
 * keybinding listener leave every chord but the toggle to the shell.
 *
 * The drawer grows out of the strip and shrinks back into it
 * (`@/lib/use-presence`): it stays mounted through its close, and its height
 * eases only while it opens or closes, so a drag still tracks the pointer.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { makeTerminalId, type TerminalId, type ThreadId } from "@poseidon/contracts/ids";
import {
  TERMINALS_PER_OWNER,
  decodeTerminalOwnerKey,
  isProjectOwner,
  isThreadOwner,
  type TerminalOwner,
  type TerminalSize,
} from "@poseidon/contracts/terminal";
import { Button } from "@poseidon/ui/components/button";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { AddSelectionButton } from "@/components/terminal/add-selection-button";
import { DevServerButton } from "@/components/terminal/dev-server-button";
import { useStopScript } from "@/components/terminal/use-stop-script";
import { useForgetDevServer } from "@/components/terminal/dev-servers";
import {
  DrawerMessage,
  IconButton,
  TerminalTabButton,
  TerminalTabStrip,
} from "@/components/terminal/drawer-parts";
import { nextTitle, useDrawerState } from "@/components/terminal/drawer-state";
import type { FileLinkHandlers } from "@/components/terminal/file-link-provider";
import { useOpenTerminal, useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { TerminalFind } from "@/components/terminal/terminal-find";
import type { TerminalHandle } from "@/components/terminal/terminal-handle";
import { useDrawerBound } from "@/components/terminal/use-drawer-bound";
import { describeExitError } from "@/lib/app-runtime";
import { TERMINAL_TOGGLE_COMMAND } from "@/lib/keybindings";
import { CommandKbd } from "@/lib/shortcuts";
import type { Presence } from "@/lib/use-presence";
import { cn } from "@/lib/utils";
import { useConnectionState } from "@/state/hooks";
import {
  DRAWER_HEIGHT_MAX_FRACTION,
  DRAWER_HEIGHT_MIN,
  useDrawerHeight,
} from "@/state/terminal-ui";
import { Add, ChevronDown, Search, Spinner } from "@honeyicons/react";

const TerminalView = React.lazy(() => import("@/components/terminal/terminal-view"));

/**
 * Drag the top edge to resize; the height atom persists every frame. The
 * height shown is also held to `bound`, so a window or composer that grows
 * after the drag still leaves the conversation its room.
 */
function useDrawerResize(drawerRef: React.RefObject<HTMLDivElement | null>) {
  const [height, setHeight] = useDrawerHeight();
  const bound = useDrawerBound(drawerRef);
  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = drawerRef.current?.getBoundingClientRect().height ?? height;
      const max = bound ?? window.innerHeight * DRAWER_HEIGHT_MAX_FRACTION;
      const onMove = (move: PointerEvent) => {
        // The drawer sits at the bottom: dragging up makes it taller.
        setHeight(startHeight + (startY - move.clientY), max);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [bound, drawerRef, height, setHeight],
  );
  const shown =
    bound === null
      ? `min(${height}px, ${DRAWER_HEIGHT_MAX_FRACTION * 100}%)`
      : `${Math.min(height, bound)}px`;
  return { shown, onPointerDown };
}

/** The New terminal button's label once the owner is at its limit. */
const limitLabel = (owner: TerminalOwner): string =>
  isThreadOwner(owner)
    ? `At most ${TERMINALS_PER_OWNER} terminals per thread`
    : isProjectOwner(owner)
      ? `At most ${TERMINALS_PER_OWNER} terminals per project`
      : `At most ${TERMINALS_PER_OWNER} terminals`;

export function TerminalDrawer({
  ownerKey,
  draftId,
  phase,
  focusRequest,
  onHide,
  onClose,
  onOpenLink,
  onOpenDevServer,
  fileLinks,
}: {
  /** The owner, a thread, a project or home, by `terminalOwnerKey`. */
  ownerKey: string;
  /** The composer draft "Add selection to chat" writes into; without one there is no such button. */
  draftId?: ThreadId | undefined;
  phase: Presence;
  focusRequest: number;
  onHide: () => void;
  onClose: (terminalId: TerminalId) => void;
  onOpenLink: (url: string) => void;
  /** Opens a dev server a running script printed, in a browser tab of its own; without it there is no such button. */
  onOpenDevServer?: ((url: string) => void) | undefined;
  /** Printed file references as links; without them a path is plain text. */
  fileLinks?: FileLinkHandlers | undefined;
}) {
  const atoms = useTerminalAtoms();
  const connected = useConnectionState().status === "connected";
  const list = useAtomValue(atoms.terminalListAtom(ownerKey));
  const refreshList = useAtomRefresh(atoms.terminalListAtom(ownerKey));
  const refreshRunning = useAtomRefresh(atoms.runningTerminalsAtom);
  const openTerminal = useOpenTerminal();
  const [state, dispatch] = useDrawerState(ownerKey);
  const forgetDevServer = useForgetDevServer();
  const stopScript = useStopScript(ownerKey);
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const { shown, onPointerDown } = useDrawerResize(drawerRef);

  const [opening, setOpening] = React.useState(false);
  const [openError, setOpenError] = React.useState<string | null>(null);
  const [measured, setMeasured] = React.useState(false);
  const [handle, setHandle] = React.useState<TerminalHandle | null>(null);
  const [finding, setFinding] = React.useState(false);
  const [tabFocus, bumpTabFocus] = React.useReducer((count: number) => count + 1, 0);
  const gridRef = React.useRef<TerminalSize | null>(null);
  const tabsRef = React.useRef(state.tabs);
  tabsRef.current = state.tabs;

  const listed = AsyncResult.isSuccess(list) ? list.value : null;
  React.useEffect(() => {
    if (listed?._tag === "ok") {
      dispatch({ type: "synced", terminals: listed.terminals });
    }
  }, [listed, dispatch]);

  const openNew = React.useCallback(async () => {
    const size = gridRef.current ?? { cols: 80, rows: 24 };
    setOpening(true);
    setOpenError(null);
    const exit = await openTerminal({
      ...decodeTerminalOwnerKey(ownerKey),
      terminalId: makeTerminalId(),
      title: nextTitle(tabsRef.current),
      ...size,
    });
    setOpening(false);
    if (exit._tag === "Success") {
      dispatch({ type: "opened", terminal: exit.value });
      bumpTabFocus();
    } else {
      setOpenError(describeExitError(exit, "Could not open a terminal."));
    }
  }, [dispatch, openTerminal, ownerKey]);

  // An open drawer with no terminals starts one — once the listing has said
  // there are none, and once the xterm has measured the grid to start it at.
  // A failed open waits for the user rather than retrying on its own, and a
  // drawer on its way out — its last tab just closed, or the New task
  // hand-over closing it before its shells move (`./terminal-hand-over`) —
  // starts nothing, whatever its listing says next.
  const listedNone = listed?._tag === "ok" && listed.terminals.length === 0;
  const leaving = phase === "leaving";
  React.useEffect(() => {
    if (
      !leaving &&
      connected &&
      listedNone &&
      measured &&
      state.tabs.length === 0 &&
      !opening &&
      openError === null
    ) {
      void openNew();
    }
  }, [leaving, connected, listedNone, measured, state.tabs.length, opening, openError, openNew]);

  const onGrid = React.useCallback((size: TerminalSize) => {
    gridRef.current = size;
    setMeasured(true);
  }, []);
  // The listings are reread too, so a count of running shells (the project's
  // badge, a thread row's mark) drops with the exit.
  const onExited = React.useCallback(
    (terminalId: TerminalId, exitCode: number | null) => {
      dispatch({ type: "exited", terminalId, exitCode });
      refreshList();
      refreshRunning();
    },
    [dispatch, refreshList, refreshRunning],
  );
  const onGone = React.useCallback(
    (terminalId: TerminalId) => {
      dispatch({ type: "closed", terminalId });
      forgetDevServer(terminalId);
    },
    [dispatch, forgetDevServer],
  );

  const close = (terminalId: TerminalId) => {
    const last = state.tabs.length === 1 && state.tabs[0]?.terminalId === terminalId;
    dispatch({ type: "closed", terminalId });
    forgetDevServer(terminalId);
    onClose(terminalId);
    if (last) {
      onHide();
    } else {
      bumpTabFocus();
    }
  };

  const closeFind = () => {
    setFinding(false);
    handle?.focus();
  };

  const full = state.tabs.length >= TERMINALS_PER_OWNER;
  const listError = listed?._tag === "error" ? listed.message : null;

  let body: React.ReactNode;
  if (!connected) {
    body = <DrawerMessage title="Not connected to a server" />;
  } else if (listError !== null && state.tabs.length === 0) {
    body = <DrawerMessage title="Could not list terminals" message={listError} />;
  } else if (openError !== null && state.tabs.length === 0) {
    body = (
      <DrawerMessage
        title="Could not open a terminal"
        message={openError}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void openNew()}>
            Try again
          </Button>
        }
      />
    );
  } else {
    body = (
      <React.Suspense
        fallback={
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Spinner variant="bold" className="size-4" />
          </div>
        }
      >
        <TerminalView
          key={state.activeId ?? "unattached"}
          ownerKey={ownerKey}
          terminalId={state.activeId}
          focusRequest={focusRequest + tabFocus}
          settling={phase !== "shown"}
          onGrid={onGrid}
          onExited={onExited}
          onGone={onGone}
          onHandle={setHandle}
          onOpenLink={onOpenLink}
          fileLinks={fileLinks}
        />
      </React.Suspense>
    );
  }

  return (
    <div
      ref={drawerRef}
      data-context="terminal"
      aria-label="Terminal"
      role="region"
      inert={leaving}
      // Not `shrink-0`: the header and composer above cannot shrink, so on a
      // window too short even for the bound's floor the drawer gives up
      // height, down to its minimum, rather than push its own bottom rows —
      // the prompt — out of the column. Opening, it starts at the strip's
      // height; closing, it ends there.
      className={cn(
        "relative flex h-(--terminal-height) min-h-(--terminal-min-height) flex-col border-t border-border bg-background",
        phase !== "shown" &&
          "overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none",
        phase === "entering" && "starting:h-8 starting:min-h-8",
      )}
      style={
        {
          "--terminal-height": phase === "leaving" ? "2rem" : shown,
          "--terminal-min-height": phase === "leaving" ? "2rem" : `${DRAWER_HEIGHT_MIN}px`,
        } as React.CSSProperties
      }
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        onPointerDown={onPointerDown}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
      />
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <TerminalTabStrip>
          {state.tabs.map((tab) => (
            <TerminalTabButton
              key={tab.terminalId}
              tab={tab}
              active={tab.terminalId === state.activeId}
              onSelect={() => {
                dispatch({ type: "activated", terminalId: tab.terminalId });
                bumpTabFocus();
              }}
              onClose={() => close(tab.terminalId)}
              onStop={() => stopScript(tab.terminalId)}
            />
          ))}
          {opening ? (
            <Spinner variant="bold" className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
        </TerminalTabStrip>
        {openError !== null && state.tabs.length > 0 ? (
          <p className="min-w-0 shrink truncate type-micro text-destructive">{openError}</p>
        ) : null}
        {onOpenDevServer === undefined ? null : (
          <DevServerButton
            tab={state.tabs.find((tab) => tab.terminalId === state.activeId)}
            onOpen={onOpenDevServer}
          />
        )}
        <IconButton
          label="Find"
          disabled={handle === null}
          onClick={() => (finding ? closeFind() : setFinding(true))}
        >
          <Search variant="bold" />
        </IconButton>
        {draftId === undefined ? null : <AddSelectionButton threadId={draftId} handle={handle} />}
        <IconButton
          label={full ? limitLabel(decodeTerminalOwnerKey(ownerKey)) : "New terminal"}
          disabled={!connected || opening || full}
          onClick={() => void openNew()}
        >
          <Add variant="bold" />
        </IconButton>
        <IconButton
          label="Hide terminal"
          onClick={onHide}
          hint={<CommandKbd command={TERMINAL_TOGGLE_COMMAND} />}
        >
          <ChevronDown variant="bold" />
        </IconButton>
      </div>
      {finding && handle !== null ? (
        <div className="flex shrink-0 justify-end px-2 pb-1">
          <TerminalFind handle={handle} onClose={closeFind} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden px-2 pb-1">{body}</div>
    </div>
  );
}
