/**
 * The xterm that shows the drawer's active terminal. Loaded lazily by the
 * drawer, so a thread view that never opens a terminal never pays for xterm.
 *
 * Each view shows one terminal: the drawer mounts it keyed by terminalId, so
 * switching tabs starts a fresh xterm, and nothing still queued in the old
 * one's write queue can reach the new terminal's screen or, as answers to its
 * queries, its shell. The first stream item is a `snapshot` the xterm is reset
 * to. With no terminal yet (`terminalId` null) it only measures, so the drawer
 * can open the first shell at the size it will be shown at.
 *
 * Unmounting disposes the xterm and ends the subscription; the shell keeps
 * running on the server, and the next mount reattaches from the snapshot.
 *
 * The drawer's toolbar reaches the xterm only through the `TerminalHandle`
 * this view hands up while it is mounted — selection and find (xterm's search
 * addon, highlighted in colours mixed from our tokens). A mod-click on a
 * printed http(s) link goes to `onOpenLink` (`./terminal-links`). A printed
 * `path:line[:col]` that `files.stat` confirms is a link on a plain click too
 * (`fileLinks`, `./file-link-provider`); any other plain click only selects.
 * A script terminal's output is also read for the dev server it prints
 * (`./dev-servers`), which the drawer then offers to open.
 *
 * Keys: the chord bound to `terminal.toggle` is refused to xterm through
 * `attachCustomKeyEventHandler`, so it bubbles to the app's one keybinding
 * listener instead of reaching the shell (off macOS, `Ctrl+J` would otherwise
 * be a line feed). Every other key is the shell's; see `@/lib/shortcuts`.
 */

import "@xterm/xterm/css/xterm.css";

import { useAtomSet } from "@effect/atom-react";
import { detectModKey, resolveKeybinding } from "@poseidon/client-runtime/keybindings";
import { encodeTerminalKey } from "@poseidon/client-runtime/terminalAtoms";
import type { TerminalId } from "@poseidon/contracts/ids";
import { decodeTerminalOwnerKey, type TerminalSize } from "@poseidon/contracts/terminal";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import { useTheme } from "@/components/theme-provider";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { scanningDevServers } from "@/components/terminal/dev-server-urls";
import { useNoteDevServerUrls } from "@/components/terminal/dev-servers";
import { type FileLinkHandlers, registerFileLinks } from "@/components/terminal/file-link-provider";
import { makeTerminalFeed } from "@/components/terminal/terminal-feed";
import type { TerminalHandle } from "@/components/terminal/terminal-handle";
import { linkToOpen } from "@/components/terminal/terminal-links";
import { readTerminalTheme, type SearchDecorations } from "@/components/terminal/terminal-theme";
import { TERMINAL_TOGGLE_COMMAND } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/shortcuts";

/** How long a run of grid changes settles before the new size is sent. */
const RESIZE_DEBOUNCE_MS = 100;

/** A grid inside the bounds `TerminalSize` accepts. */
const boundedSize = (cols: number, rows: number): TerminalSize => ({
  cols: Math.max(2, Math.min(1000, cols)),
  rows: Math.max(1, Math.min(500, rows)),
});

interface Xterm {
  readonly terminal: Terminal;
  readonly fit: FitAddon;
  readonly search: SearchAddon;
}

/**
 * A counter that moves whenever the app's look may have changed: the resolved
 * theme, or the root element's class or inline style — where the theme class
 * and the Appearance font scales are applied, and which catches a change
 * `useTheme` does not report.
 */
function useLookVersion(): string {
  const { resolvedTheme } = useTheme();
  const [mutations, bump] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    const observer = new MutationObserver(() => bump());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  return `${resolvedTheme ?? ""}:${mutations}`;
}

function TerminalAttachment({
  ownerKey,
  terminalId,
  terminal,
  onExited,
  onGone,
}: {
  /** The terminal's owner, a thread, a project or home, by `terminalOwnerKey`. */
  ownerKey: string;
  terminalId: TerminalId;
  terminal: Terminal;
  onExited: (terminalId: TerminalId, exitCode: number | null) => void;
  onGone: (terminalId: TerminalId) => void;
}) {
  const atoms = useTerminalAtoms();
  const setAttach = useAtomSet(
    atoms.terminalAttachAtom(
      encodeTerminalKey({ ...decodeTerminalOwnerKey(ownerKey), terminalId }),
    ),
  );
  const write = useAtomSet(atoms.writeTerminal);
  const resize = useAtomSet(atoms.resizeTerminal);
  const noteDevServers = useNoteDevServerUrls(terminalId);
  const handlersRef = React.useRef({ onExited, onGone });
  handlersRef.current = { onExited, onGone };

  React.useEffect(() => {
    const ref = { ...decodeTerminalOwnerKey(ownerKey), terminalId };
    let sent: TerminalSize | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sendSize = () => {
      const size = boundedSize(terminal.cols, terminal.rows);
      if (sent?.cols === size.cols && sent.rows === size.rows) {
        return;
      }
      sent = size;
      resize({ ...ref, ...size });
    };

    const feed = makeTerminalFeed(terminal, {
      onSnapshot: (size) => {
        sent = size;
        sendSize();
      },
      onExited: (exitCode) => handlersRef.current.onExited(terminalId, exitCode),
      onGone: () => handlersRef.current.onGone(terminalId),
    });

    // A fn atom's value is its argument, and a function would be taken for an
    // updater, so the callback goes in wrapped. A script's output is read
    // for the dev server it prints (`./dev-servers`).
    setAttach(() => scanningDevServers(feed.push, noteDevServers));
    const input = terminal.onData((data) => {
      if (feed.sends(data)) {
        write({ ...ref, data });
      }
    });
    const grid = terminal.onResize(() => {
      clearTimeout(timer);
      timer = setTimeout(sendSize, RESIZE_DEBOUNCE_MS);
    });
    return () => {
      feed.stop();
      clearTimeout(timer);
      input.dispose();
      grid.dispose();
      setAttach(Atom.Reset);
    };
  }, [ownerKey, terminalId, terminal, setAttach, write, resize, noteDevServers]);

  return null;
}

export default function TerminalView({
  ownerKey,
  terminalId,
  focusRequest,
  settling,
  onGrid,
  onExited,
  onGone,
  onHandle,
  onOpenLink,
  fileLinks,
}: {
  /** The terminal's owner, a thread, a project or home, by `terminalOwnerKey`. */
  ownerKey: string;
  terminalId: TerminalId | null;
  /** Focus the terminal whenever this changes; 0 means "not asked yet". */
  focusRequest: number;
  /**
   * The drawer is opening or closing. The xterm keeps its grid until the
   * drawer settles rather than fit every frame of the way — a shell started
   * or resized to the few rows of a half-open drawer — and fits once it has.
   */
  settling: boolean;
  /** The grid after every fit, so the drawer can open a shell at that size. */
  onGrid: (size: TerminalSize) => void;
  onExited: (terminalId: TerminalId, exitCode: number | null) => void;
  onGone: (terminalId: TerminalId) => void;
  /** The handle once the xterm is open, and null once it is gone. */
  onHandle: (handle: TerminalHandle | null) => void;
  /** A link the user mod-clicked, already checked to be http(s). */
  onOpenLink: (url: string) => void;
  /** Confirms and opens the file references the terminal prints. */
  fileLinks?: FileLinkHandlers | undefined;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [xterm, setXterm] = React.useState<Xterm | null>(null);
  const look = useLookVersion();

  const keybindings = useKeybindings();
  const toggleBindingsRef = React.useRef(keybindings);
  toggleBindingsRef.current = keybindings.filter(
    (binding) => binding.command === TERMINAL_TOGGLE_COMMAND,
  );
  const onGridRef = React.useRef(onGrid);
  onGridRef.current = onGrid;
  const settlingRef = React.useRef(settling);
  settlingRef.current = settling;
  const onOpenLinkRef = React.useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const fileLinksRef = React.useRef(fileLinks);
  fileLinksRef.current = fileLinks;
  // Find's highlight colours, re-read with the theme.
  const decorationsRef = React.useRef<SearchDecorations | null>(null);

  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const { theme, search: decorations, fontFamily } = readTerminalTheme(host);
    decorationsRef.current = decorations;
    const terminal = new Terminal({
      theme,
      fontFamily,
      fontSize: Number.parseFloat(getComputedStyle(host).fontSize) || 12,
      scrollback: 5000,
      macOptionIsMeta: false,
      cursorBlink: true,
      // xterm's ANSI palette is tuned for a dark background: white and bright
      // yellow all but vanish on the light theme. xterm lifts any colour below
      // this contrast against its cell's background as it draws — WCAG AA for
      // text — so no colour value of our own is needed.
      minimumContrastRatio: 4.5,
      // Find highlights every match through xterm's decorations, which are
      // still proposed API; the search addon is the only thing that uses them.
      allowProposedApi: true,
    });
    const modKey = detectModKey();
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        const url = linkToOpen(uri, event, modKey);
        if (url !== null) {
          onOpenLinkRef.current(url);
        }
      }),
    );
    const search = new SearchAddon();
    terminal.loadAddon(search);
    const files = registerFileLinks(terminal, {
      resolve: (paths) => fileLinksRef.current?.resolve(paths) ?? Promise.resolve([]),
      activate: (...args) => fileLinksRef.current?.activate(...args),
    });

    const inTerminal = (name: string) =>
      name === "terminalFocus" ? true : name === "composerFocus" ? false : undefined;
    terminal.attachCustomKeyEventHandler(
      (event) => resolveKeybinding(toggleBindingsRef.current, event, inTerminal, modKey) === null,
    );

    terminal.open(host);
    const refit = () => {
      if (settlingRef.current) {
        return;
      }
      fit.fit();
      onGridRef.current(boundedSize(terminal.cols, terminal.rows));
    };
    refit();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    });
    observer.observe(host);
    setXterm({ terminal, fit, search });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      setXterm(null);
      files.dispose();
      terminal.dispose();
    };
  }, []);

  // Re-read the tokens when the theme or the font scale changes.
  React.useEffect(() => {
    const host = hostRef.current;
    if (xterm === null || host === null) {
      return;
    }
    const { theme, search: decorations, fontFamily } = readTerminalTheme(host);
    decorationsRef.current = decorations;
    xterm.terminal.options.theme = theme;
    xterm.terminal.options.fontFamily = fontFamily;
    xterm.terminal.options.fontSize = Number.parseFloat(getComputedStyle(host).fontSize) || 12;
    if (!settlingRef.current) {
      xterm.fit.fit();
      onGridRef.current(boundedSize(xterm.terminal.cols, xterm.terminal.rows));
    }
  }, [xterm, look]);

  // The fit the drawer's transition held back, once it has settled.
  React.useEffect(() => {
    if (xterm !== null && !settling) {
      xterm.fit.fit();
      onGridRef.current(boundedSize(xterm.terminal.cols, xterm.terminal.rows));
    }
  }, [xterm, settling]);

  React.useEffect(() => {
    if (xterm === null) {
      return;
    }
    const { terminal, search } = xterm;
    onHandle({
      selection: () => terminal.getSelection(),
      clearSelection: () => terminal.clearSelection(),
      watchSelection: (listener) => {
        listener(terminal.hasSelection());
        const change = terminal.onSelectionChange(() => listener(terminal.hasSelection()));
        return () => change.dispose();
      },
      find: (query, direction, incremental = false) => {
        const decorations = decorationsRef.current;
        const options = { incremental, ...(decorations !== null && { decorations }) };
        return direction === "next"
          ? search.findNext(query, options)
          : search.findPrevious(query, options);
      },
      watchFindResults: (listener) => {
        const change = search.onDidChangeResults(({ resultIndex, resultCount }) =>
          listener({ index: resultIndex, count: resultCount }),
        );
        return () => change.dispose();
      },
      clearFind: () => search.clearDecorations(),
      focus: () => terminal.focus(),
    });
    return () => onHandle(null);
  }, [xterm, onHandle]);

  React.useEffect(() => {
    if (xterm !== null && focusRequest > 0) {
      xterm.terminal.focus();
    }
  }, [xterm, focusRequest, terminalId]);

  return (
    <>
      <div ref={hostRef} className="size-full overflow-hidden font-mono text-xs" />
      {xterm !== null && terminalId !== null ? (
        <TerminalAttachment
          key={terminalId}
          ownerKey={ownerKey}
          terminalId={terminalId}
          terminal={xterm.terminal}
          onExited={onExited}
          onGone={onGone}
        />
      ) : null}
    </>
  );
}
