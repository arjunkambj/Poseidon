/**
 * What a `when` clause reads for one keypress.
 *
 * Two halves, so the rule is testable without a DOM. `focusSnapshot` reads the
 * page at the moment of the press: whether focus is in a text field, which
 * surface it is in (the closest `data-context` — `composer`, `terminal`,
 * `browser`, `files`), and whether an overlay is on screen. `keybindingContext` turns
 * that snapshot, the registry's published flags and the platform into the
 * lookup the matcher calls.
 *
 * The keys themselves, with what each means and who sets it, are listed in
 * `KEYBINDING_CONTEXT_KEYS` (`@poseidon/client-runtime/keymap`). The built-in
 * ones are answered here and never from the registry, so no component can
 * publish a focus it does not hold; every other name is the registry's, read
 * under its canonical name so an old clause saying `threadRunning` still reads
 * `turnRunning`.
 */

import type { WhenContext } from "@poseidon/client-runtime/keybindings";
import { KEYBINDING_CONTEXT_KEYS } from "@poseidon/client-runtime/keymap";

import type { FlagValue } from "@/lib/command-registry";

/** The DOM half of a keypress's context, read once per event. */
export interface FocusSnapshot {
  /** Focus is in a text field, where plain keys are typing. */
  readonly editable: boolean;
  /** The focused element's closest `data-context`, if any. */
  readonly surface: string | undefined;
  /** A dialog, popover, menu or listbox is on screen and owns the keyboard. */
  readonly overlayOpen: boolean;
}

/** A target where plain keys are text the user is typing. */
const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable);

/**
 * The surfaces that outrank everything behind them: base-ui's dialog,
 * popover, menu and select popups, and the composer's own inline `/` and `@`
 * menu, which is not portalled. All of them render one of these roles.
 */
const OVERLAY_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="menubar"],[role="listbox"]';

/**
 * The `data-context` a surface sets on its root so focus anywhere inside it
 * reads as that surface's focus key: the composers set it on their textarea,
 * the browser pane on the element holding its address bar and page, the Files
 * pane on its root.
 */
export const FOCUS_SURFACE = {
  composer: "composer",
  terminal: "terminal",
  browser: "browser",
  files: "files",
} as const;

/** The part of an element `surfaceOf` reads — structural, so a test needs no DOM. */
interface SurfaceElement {
  readonly closest: (selector: string) => { getAttribute(name: string): string | null } | null;
}

/** The focused element's closest `data-context`, if any. */
export const surfaceOf = (target: EventTarget | null): string | undefined => {
  const element = target as Partial<SurfaceElement> | null;
  return typeof element?.closest === "function"
    ? (element.closest("[data-context]")?.getAttribute("data-context") ?? undefined)
    : undefined;
};

/** Reads the page for one keypress. */
export const focusSnapshot = (event: KeyboardEvent): FocusSnapshot => ({
  editable: isEditableTarget(event.target),
  surface: surfaceOf(event.target),
  overlayOpen: document.querySelector(OVERLAY_SELECTOR) !== null,
});

/** Alias → canonical name, from the one list of context keys. */
const CANONICAL: ReadonlyMap<string, string> = new Map(
  KEYBINDING_CONTEXT_KEYS.flatMap((key) =>
    (key.aliases ?? []).map((alias): [string, string] => [alias, key.name]),
  ),
);

/**
 * The lookup a `when` clause evaluates against. `flags` is the registry's
 * reader for published keys; built-in keys never reach it.
 */
export const keybindingContext = (
  snapshot: FocusSnapshot,
  flags: (name: string) => FlagValue | undefined,
  isMac: boolean,
): WhenContext => {
  const builtin: ReadonlyMap<string, boolean> = new Map([
    ["inputFocus", snapshot.editable],
    ["composerFocus", snapshot.surface === FOCUS_SURFACE.composer],
    ["terminalFocus", snapshot.surface === FOCUS_SURFACE.terminal],
    ["browserFocus", snapshot.surface === FOCUS_SURFACE.browser],
    ["filesFocus", snapshot.surface === FOCUS_SURFACE.files],
    ["dialogOpen", snapshot.overlayOpen],
    ["isMac", isMac],
  ]);
  return (name) => {
    const canonical = CANONICAL.get(name) ?? name;
    return builtin.has(canonical) ? builtin.get(canonical) : flags(canonical);
  };
};
