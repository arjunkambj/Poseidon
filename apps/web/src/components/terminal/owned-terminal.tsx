/**
 * Where the terminal drawer is mounted, and who owns what it shows.
 *
 * `ThreadTerminal` is always mounted with the thread view: its terminals are
 * the thread's and start in its workspace. `ProjectTerminal` is mounted with
 * the New task page, where no thread exists yet: its terminals are the
 * project's own (`TerminalOwner`) and start in the project's folder — never
 * keyed by the page's draft id, since the thread that draft becomes may run in
 * a new worktree.
 *
 * Either answers `terminal.toggle` and renders the drawer (`./terminal-drawer`)
 * while its owner's drawer is open (`@/state/terminal-ui`, keyed by
 * `terminalOwnerKey`), and the strip with its show button (`./terminal-bar`)
 * while it is not. A mod-clicked link opens in the thread's browser pane
 * (`./use-open-link`); the New task page has no browser pane, so there it
 * opens in the system browser. A dev server a script printed opens the way
 * the Run menu opens one: a tab of the thread's in-app browser
 * (`openInThreadBrowser`), or on the New task page the system browser.
 *
 * A printed `path:line[:col]` the owner's root holds is a link too
 * (`./use-file-links`): a plain click shows it in the thread's Files tab, a
 * mod-click opens it in the favourite editor. The New task page has no Files
 * tab to answer, so there only the mod-click does anything.
 */

import { useAtomSet } from "@effect/atom-react";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import { decodeTerminalOwnerKey, terminalOwnerKey } from "@poseidon/contracts/terminal";
import * as React from "react";

import { openInThreadBrowser } from "@/components/panes/browser/open-in-browser";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { TerminalBar } from "@/components/terminal/terminal-bar";
import { TerminalDrawer } from "@/components/terminal/terminal-drawer";
import { useFileLinks } from "@/components/terminal/use-file-links";
import { useOpenInBrowserPane } from "@/components/terminal/use-open-link";
import { openExternal } from "@/lib/desktop";
import { TERMINAL_TOGGLE_COMMAND } from "@/lib/keybindings";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { usePresence } from "@/lib/use-presence";
import { useTerminalOpen } from "@/state/terminal-ui";

/**
 * Shows the owner's drawer while open (and while it closes), the collapsed
 * strip once it has.
 */
function OwnedTerminal({
  ownerKey,
  projectId,
  threadId,
  draftId,
  onOpenLink,
  onOpenDevServer,
}: {
  ownerKey: string;
  /** The root file links resolve in: the thread's workspace, else the project's folder. */
  projectId: ProjectId;
  threadId?: ThreadId;
  draftId: ThreadId;
  onOpenLink: (url: string) => void;
  onOpenDevServer: (url: string) => void;
}) {
  const fileLinks = useFileLinks({ projectId, threadId });
  const [open, setOpen] = useTerminalOpen(ownerKey);
  const [focusRequest, bumpFocus] = React.useReducer((count: number) => count + 1, 0);
  // Mounted here, not in the drawer: closing the last tab hides the drawer,
  // and the close must not be cut short by the drawer unmounting.
  const closeTerminal = useAtomSet(useTerminalAtoms().closeTerminal);

  const phase = usePresence(open);

  useKeybindingCommand(TERMINAL_TOGGLE_COMMAND, () => {
    if (!open) {
      bumpFocus();
    }
    setOpen(!open);
  });

  if (phase === null) {
    return <TerminalBar />;
  }
  return (
    <TerminalDrawer
      ownerKey={ownerKey}
      draftId={draftId}
      phase={phase}
      focusRequest={focusRequest}
      onHide={() => setOpen(false)}
      onClose={(terminalId) => closeTerminal({ ...decodeTerminalOwnerKey(ownerKey), terminalId })}
      onOpenLink={onOpenLink}
      onOpenDevServer={onOpenDevServer}
      fileLinks={fileLinks}
    />
  );
}

/**
 * The thread's drawer. Mount it keyed by threadId, so each thread starts with
 * its own drawer rather than inheriting the last one's xterm. `onShowBrowser`
 * puts the dock on its Browser tab, for a link the terminal opens there.
 */
export function ThreadTerminal({
  threadId,
  projectId,
  onShowBrowser,
}: {
  threadId: ThreadId;
  projectId: ProjectId;
  onShowBrowser: () => void;
}) {
  const openLink = useOpenInBrowserPane(threadId, onShowBrowser);
  return (
    <OwnedTerminal
      ownerKey={terminalOwnerKey({ threadId })}
      projectId={projectId}
      threadId={threadId}
      draftId={threadId}
      onOpenLink={openLink}
      onOpenDevServer={(url) => void openInThreadBrowser(threadId, url)}
    />
  );
}

/**
 * The New task page's drawer: the project's own terminals, in its folder.
 * Mount it keyed by projectId. A selection goes into the page's draft
 * (`draftId`, the id the thread will get once sent).
 */
export function ProjectTerminal({
  projectId,
  draftId,
}: {
  projectId: ProjectId;
  draftId: ThreadId;
}) {
  return (
    <OwnedTerminal
      ownerKey={terminalOwnerKey({ projectId })}
      projectId={projectId}
      draftId={draftId}
      onOpenLink={openExternal}
      onOpenDevServer={openExternal}
    />
  );
}
