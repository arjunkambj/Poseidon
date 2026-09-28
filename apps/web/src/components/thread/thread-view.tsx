/**
 * The center column of `/t/$threadId`: a slim header (`thread-header.tsx`:
 * title, worktree, status, dock toggle) over the virtualized `Timeline`, with
 * the composer — and the interaction cards it carries — pinned underneath and
 * the right dock alongside. Data comes from `useThreadDetail` — an
 * `AsyncResult` that carries its own loading/failure states, so the view never
 * has to know whether the socket is mid-resnapshot.
 *
 * The dock keys — `dock.toggle`, `dock.changes`, `dock.files` and
 * `browserPane.toggle` — are answered here, through `DockShortcuts` and
 * `BrowserPaneShortcut`, because they need the thread's dock. The dock starts
 * closed: `?pane=` says what it shows (a tab, or `home` for its launcher), and
 * the only thing that opens it unasked is coming back, in the same session,
 * to a thread whose dock was left open (`useDockState`, over a memory kept in
 * memory, so a relaunch finds every dock shut). The toggle reopens the last
 * tab this thread used this session, else the launcher
 * (`@/components/dock/dock-toggle`). The timeline's file chips
 * ask for a file with `useRequestFileReveal`; `useFileRevealRequests` answers
 * here by writing it into the thread's Files view (`useRevealFile`) and
 * opening the dock on Files. The rest of the thread-scoped bindings —
 * `thread.interrupt`, `composer.queue` and the `turnRunning` flag — belong to
 * the composer, which owns the Stop button and the error line those bindings
 * report through. The layout keeps the bindings that work with no thread open.
 * The terminal drawer sits in the thread column below the composer and answers
 * `terminal.toggle` itself; the links it opens land on this dock's Browser tab.
 * This view publishes `threadOpen` while it is mounted and `dockOpen` while
 * the right dock is, and mounts `ThreadShortcuts` — rename, archive and delete
 * for this thread — once the snapshot is in.
 */

import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import * as React from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import type * as PoseidonRpcError from "@poseidon/contracts/rpc";
import { cn } from "@poseidon/ui/lib/utils";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import { Composer } from "@/components/composer/composer";
import type { DockPane } from "@/components/dock/dock-toggle";
import { RightDock } from "@/components/dock/right-dock";
import { useDockState } from "@/components/dock/use-dock-state";
import { useRevealFile } from "@/components/panes/files/files-view";
import { ThreadTerminal } from "@/components/terminal/owned-terminal";
import { useAgentBrowser } from "@/components/thread/agent-browser-indicator";
import { ThreadHarnessBanner } from "@/components/thread/harness-health-banner";
import { ThreadHeader } from "@/components/thread/thread-header";
import { ThreadGreeting } from "@/components/thread/thread-greeting";
import {
  BrowserPaneShortcut,
  DockShortcuts,
  ThreadShortcuts,
} from "@/components/thread/thread-shortcuts";
import { Timeline } from "@/components/timeline/timeline";
import { useKeybindingFlag } from "@/lib/shortcuts";
import { useConnectionState, useProjects, useThreadDetail } from "@/state/hooks";
import { useChatWidth } from "@/lib/use-chat-width";
import { useBrowserRevealRequests } from "@/state/browser-activity";
import { type FileRevealTarget, useFileRevealRequests } from "@/state/file-reveal";
import { AlertTriangle, Spinner, WifiOff } from "@honeyicons/react";

type ThreadDetailResult = AsyncResult.AsyncResult<
  ThreadDetailSnapshot,
  PoseidonRpcError.PoseidonRpcError | RpcClientError.RpcClientError | Cause.NoSuchElementError
>;

/** First squashed error line, or null when the cause says nothing. */
function failureMessage(result: ThreadDetailResult): string | null {
  if (!AsyncResult.isFailure(result)) {
    return null;
  }
  const pretty = Cause.pretty(result.cause).trim();
  const firstLine = pretty.split("\n", 1)[0];
  return firstLine === undefined || firstLine === "" ? null : firstLine;
}

/**
 * The snapshot to render right now: the current value on success, or the last
 * good one a failed refresh kept. A failed refresh should not blank the
 * timeline — the connection banner already explains the retry.
 */
const snapshotOf = (result: ThreadDetailResult): ThreadDetailSnapshot | null => {
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  if (AsyncResult.isFailure(result) && result.previousSuccess._tag === "Some") {
    return result.previousSuccess.value.value;
  }
  return null;
};

/** A fresh thread: the greeting, for the project and worktree the thread works in. */
function EmptyThread({ snapshot }: { snapshot: ThreadDetailSnapshot }) {
  const project = useProjects().find((entry) => entry.projectId === snapshot.projectId);
  return <ThreadGreeting project={project} worktree={snapshot.worktree} />;
}

function ThreadBody({ result, connected }: { result: ThreadDetailResult; connected: boolean }) {
  const snapshot = snapshotOf(result);
  if (snapshot !== null) {
    if (snapshot.items.length === 0) {
      return <EmptyThread snapshot={snapshot} />;
    }
    return <Timeline snapshot={snapshot} />;
  }
  if (AsyncResult.isFailure(result)) {
    const message = failureMessage(result);
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertTriangle variant="bold" className="text-destructive" />
          </EmptyMedia>
          <EmptyTitle>Could not load this thread</EmptyTitle>
          {message === null ? null : <EmptyDescription>{message}</EmptyDescription>}
        </EmptyHeader>
      </Empty>
    );
  }
  // No server resolved at all — the subscription never starts, so say so
  // instead of spinning on a load that cannot finish.
  if (!connected) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WifiOff variant="bold" />
          </EmptyMedia>
          <EmptyTitle>Not connected to a server</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center gap-2 type-body text-muted-foreground">
      <Spinner variant="bold" className="size-4" />
      Loading thread…
    </div>
  );
}

export function ThreadView({
  threadId,
  dockTab,
}: {
  threadId: ThreadId;
  dockTab: DockPane | undefined;
}) {
  const result = useThreadDetail(threadId);
  const connection = useConnectionState();
  const chatWidth = useChatWidth();
  const navigate = useNavigate();

  const navigateDock = React.useCallback(
    (tab: DockPane | null) =>
      void navigate({
        to: "/t/$threadId",
        params: { threadId },
        search: { pane: tab ?? undefined },
        replace: true,
      }),
    [navigate, threadId],
  );

  // The agent's use of the browser: the header's indicator, and the
  // auto-open setting. An auto-open is not remembered as the thread's dock
  // tab — only the user's own choice is.
  const autoOpenBrowser = React.useCallback(() => navigateDock("browser"), [navigateDock]);
  const agentBrowser = useAgentBrowser(threadId, dockTab, autoOpenBrowser);

  const dock = useDockState({
    memoryKey: threadId,
    dockTab,
    navigateDock,
    onUserMove: agentBrowser.noteUserDock,
  });
  const { setDockTab } = dock;

  const showBrowser = React.useCallback(() => setDockTab("browser"), [setDockTab]);
  // `openInThreadBrowser` asks for the pane from outside the thread view.
  useBrowserRevealRequests(threadId, showBrowser);

  // A file chip's request: the file goes into this thread's Files view, at
  // its line, and the dock opens on Files to show it.
  const revealFile = useRevealFile(threadId);
  const showFile = React.useCallback(
    (target: FileRevealTarget) => {
      revealFile(target);
      setDockTab("files");
    },
    [revealFile, setDockTab],
  );
  useFileRevealRequests(threadId, showFile);

  const snapshot = snapshotOf(result);

  // The client fold turns `thread.deleted` into this status for exactly this
  // purpose: the server drops a deleted thread from the read model, so the only
  // thing left to do with an open timeline is leave it.
  const deleted = snapshot?.status === "deleted";
  React.useEffect(() => {
    if (deleted) {
      void navigate({ to: "/" });
    }
  }, [deleted, navigate]);

  useKeybindingFlag("threadOpen", true);

  // `thread.interrupt`, `composer.queue` and the `turnRunning` flag belong to
  // the `Composer` below, not here. Both components used to register all three,
  // and which one won depended on whether the thread detail was already cached
  // at first paint — so Escape either showed the Stop button's "Stopping…"
  // state and reported a rejected interrupt, or did neither, on the same
  // thread. The composer is the surface with the visible Stop button and the
  // error line, so it is the one that answers. This view keeps the dock keys,
  // which are really its own.

  return (
    // The dock overlays when this row cannot fit both columns, including
    // when a wide sidebar leaves little space in a desktop window.
    <div className="@container/thread relative flex min-h-0 min-w-0 flex-1">
      {/* The thread column's floor (`THREAD_COLUMN_MIN`); the dock's width
          bound yields to it when there is room for a 280px dock beside it. */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col @min-[640px]/thread:min-w-90">
        {snapshot !== null ? (
          <>
            <ThreadShortcuts threadId={threadId} title={snapshot.title} status={snapshot.status} />
            <DockShortcuts dockTab={dockTab} onToggle={dock.toggleDock} onShow={dock.showDockTab} />
            <BrowserPaneShortcut dockTab={dockTab} onShow={dock.showDockTab} />
          </>
        ) : null}
        {snapshot !== null ? (
          <ThreadHeader
            snapshot={snapshot}
            dockTab={dockTab}
            onDockToggle={dock.toggleDock}
            onShowBrowser={agentBrowser.indicator ? showBrowser : null}
          />
        ) : null}
        <ThreadBody result={result} connected={connection.status !== "disconnected"} />
        {snapshot !== null ? (
          <div className="flex w-full shrink-0 flex-col items-center gap-2 px-6 pb-4">
            {/* Hidden while the banner renders nothing, so it adds no gap. */}
            <div className={cn("w-full empty:hidden", chatWidth.classes.column)}>
              <ThreadHarnessBanner snapshot={snapshot} />
            </div>
            <Composer threadId={threadId} projectId={snapshot.projectId} />
          </div>
        ) : null}
        {snapshot !== null ? (
          <ThreadTerminal
            key={threadId}
            threadId={threadId}
            onShowBrowser={() => setDockTab("browser")}
          />
        ) : null}
      </section>
      {dock.phase !== null && dock.shownDockTab !== undefined && snapshot !== null ? (
        <RightDock
          pane={dock.shownDockTab}
          phase={dock.phase}
          onPaneChange={setDockTab}
          openTabs={dock.openTabs}
          onCloseTab={dock.closeTab}
          scope={{ snapshot }}
          focusFilesSearch={dock.focusFilesSearch}
          onFilesSearchFocused={dock.onFilesSearchFocused}
          focusLauncher={dock.focusLauncher}
          onLauncherFocused={dock.onLauncherFocused}
        />
      ) : null}
    </div>
  );
}
