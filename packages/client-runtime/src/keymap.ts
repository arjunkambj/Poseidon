/**
 * Reasoning about a keymap as a whole, rather than one keypress: which
 * context keys a `when` clause may name, which chords are physically the same
 * key on a platform, whether two bindings can ever be live at once, and which
 * chords the operating system or the Electron shell already owns.
 *
 * The matcher itself — parsing, matching one event, evaluating one clause —
 * is `./keybindings`; this module builds on it.
 */

import { CHANGES_PANE_KEYS, SIDEBAR_UNDO_KEYS } from "@poseidon/contracts/keybindings";
import type { Keybinding } from "@poseidon/contracts/settings";

import {
  evaluateWhenNode,
  firesInTextField,
  parseShortcut,
  parseWhen,
  type ModKey,
  type ParsedShortcut,
  type WhenNode,
  unshiftedKey,
} from "./keybindings";

// ── Context keys ───────────────────────────────────────────────

export interface KeybindingContextKey {
  readonly name: string;
  readonly description: string;
  /**
   * `builtin` keys are computed by the listener from the keypress itself;
   * `published` keys are set by whichever component knows them.
   */
  readonly kind: "builtin" | "published";
  /** Older names that mean the same key. */
  readonly aliases?: ReadonlyArray<string>;
}

/** Every context key a `when` clause may name. Any other name is always false. */
export const KEYBINDING_CONTEXT_KEYS: ReadonlyArray<KeybindingContextKey> = [
  {
    name: "inputFocus",
    description: "Focus is in a text field: an input, a textarea or an editable element.",
    kind: "builtin",
  },
  { name: "composerFocus", description: "Focus is in the composer.", kind: "builtin" },
  { name: "terminalFocus", description: "Focus is in the terminal.", kind: "builtin" },
  { name: "browserFocus", description: "Focus is in the browser pane.", kind: "builtin" },
  { name: "filesFocus", description: "Focus is in the Files pane.", kind: "builtin" },
  {
    name: "dialogOpen",
    description: "A dialog, alert, menu or list popup is on screen.",
    kind: "builtin",
  },
  { name: "isMac", description: "The app is running on macOS.", kind: "builtin" },
  { name: "threadOpen", description: "A thread is on screen.", kind: "published" },
  {
    name: "newTaskOpen",
    description: "The New task page is on screen, with a project picked.",
    kind: "published",
  },
  { name: "dockOpen", description: "The right dock is open.", kind: "published" },
  { name: "changesOpen", description: "The dock is showing the Changes pane.", kind: "published" },
  {
    name: "turnRunning",
    description: "The open thread has a turn running.",
    kind: "published",
    aliases: ["threadRunning"],
  },
  {
    name: "approvalPending",
    description: "The open thread is waiting on a tool approval.",
    kind: "published",
  },
  {
    name: "questionPending",
    description: "The open thread is waiting on an answer to a question.",
    kind: "published",
  },
  {
    name: "planPending",
    description: "The open thread is waiting on a plan decision.",
    kind: "published",
  },
];

/**
 * What always holds between the context keys, so the overlap check does not
 * report pairs that can never be live together.
 *
 * - `composerFocus` and `terminalFocus` each imply `inputFocus` (the terminal
 *   focuses a textarea).
 * - Focus is in at most one of the composer, the terminal, the browser and the
 *   Files pane.
 * - At most one of an approval, a question and a plan is pending.
 * - `isMac` is fixed for a platform.
 */
export const CONTEXT_AXIOMS = {
  implies: [
    ["composerFocus", "inputFocus"],
    ["terminalFocus", "inputFocus"],
  ],
  exclusive: [
    ["composerFocus", "terminalFocus", "browserFocus", "filesFocus"],
    ["approvalPending", "questionPending", "planPending"],
    ["threadOpen", "newTaskOpen"],
  ],
  platform: "isMac",
} as const;

const CANONICAL_NAME: ReadonlyMap<string, string> = new Map(
  KEYBINDING_CONTEXT_KEYS.flatMap((key) =>
    (key.aliases ?? []).map((alias): [string, string] => [alias, key.name]),
  ),
);

// ── Overlap ────────────────────────────────────────────────────

/**
 * Rewrites a clause over plain boolean atoms: aliases take their canonical
 * name, and `x == "v"` becomes the atom `x=="v"` — an independent flag, which
 * can only make the check report more overlap, never less.
 */
const atomize = (node: WhenNode): WhenNode => {
  switch (node.kind) {
    case "const":
      return node;
    case "flag":
      return { kind: "flag", name: CANONICAL_NAME.get(node.name) ?? node.name };
    case "compare": {
      const name = `${CANONICAL_NAME.get(node.name) ?? node.name}==${JSON.stringify(node.value)}`;
      const atom: WhenNode = { kind: "flag", name };
      return node.equal ? atom : { kind: "not", operand: atom };
    }
    case "not":
      return { kind: "not", operand: atomize(node.operand) };
    case "and":
    case "or":
      return { kind: node.kind, left: atomize(node.left), right: atomize(node.right) };
  }
};

const atomsOf = (node: WhenNode, into: Set<string>): Set<string> => {
  switch (node.kind) {
    case "const":
      return into;
    case "flag":
      return into.add(node.name);
    case "compare":
      return into.add(node.name);
    case "not":
      return atomsOf(node.operand, into);
    case "and":
    case "or":
      return atomsOf(node.right, atomsOf(node.left, into));
  }
};

/**
 * An assignment respects the axioms. Only atoms the clauses name are assigned;
 * any other key is free, and every axiom can be met by choosing it (an implied
 * key true, an exclusive one false), so an axiom is checked only between named
 * atoms.
 */
const consistent = (value: ReadonlyMap<string, boolean>, platform: ModKey): boolean => {
  for (const [premise, conclusion] of CONTEXT_AXIOMS.implies) {
    if (value.get(premise) === true && value.get(conclusion) === false) {
      return false;
    }
  }
  for (const group of CONTEXT_AXIOMS.exclusive) {
    if (group.filter((name) => value.get(name) === true).length > 1) {
      return false;
    }
  }
  const isMac = value.get(CONTEXT_AXIOMS.platform);
  return isMac === undefined || isMac === (platform === "meta");
};

/** Beyond this many atoms the truth table is skipped and overlap assumed. */
const MAX_ATOMS = 16;

/** Some assignment the axioms allow makes both clauses true. */
const nodesOverlap = (a: WhenNode, b: WhenNode, platform: ModKey): boolean => {
  const atoms = [...atomsOf(b, atomsOf(a, new Set()))];
  if (atoms.length > MAX_ATOMS) {
    return true;
  }
  for (let mask = 0; mask < 1 << atoms.length; mask += 1) {
    const value = new Map(atoms.map((atom, bit) => [atom, (mask & (1 << bit)) !== 0]));
    if (!consistent(value, platform)) {
      continue;
    }
    const context = (name: string) => value.get(name) === true;
    if (evaluateWhenNode(a, context) && evaluateWhenNode(b, context)) {
      return true;
    }
  }
  return false;
};

/**
 * Whether two `when` clauses can hold at the same time on `platform`, by
 * brute force over the atoms they name, honouring `CONTEXT_AXIOMS`. A missing
 * or empty clause always holds. An unparseable clause never overlaps anything:
 * it disables its binding.
 */
export const whenOverlaps = (
  a: string | undefined,
  b: string | undefined,
  platform: ModKey,
): boolean => {
  const left = parseWhen(a ?? "");
  const right = parseWhen(b ?? "");
  return left !== null && right !== null && nodesOverlap(atomize(left), atomize(right), platform);
};

const INPUT_FOCUS: WhenNode = { kind: "flag", name: "inputFocus" };

/**
 * The context a binding is really live in: its clause, plus `!inputFocus`
 * when the text-field rule keeps it out of text fields. Null when the clause
 * does not parse.
 */
const effectiveWhen = (binding: Keybinding, shortcut: ParsedShortcut): WhenNode | null => {
  const node = parseWhen(binding.when ?? "");
  if (node === null) {
    return null;
  }
  const guarded: WhenNode = firesInTextField(shortcut, binding.when)
    ? node
    : { kind: "and", left: node, right: { kind: "not", operand: INPUT_FOCUS } };
  return atomize(guarded);
};

// ── Physical chords ────────────────────────────────────────────

export interface PhysicalChord {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/**
 * The keys actually held for a chord on a platform. Off macOS `Mod` is
 * Control, so `Mod+X` and `Ctrl+X` are the same chord there. With Shift held
 * a shifted character names its own key, so `Mod+Shift+{` is `Mod+Shift+[`
 * and `Shift+?` is `Shift+/` — the matcher fires both on the one press.
 */
export const physicalChord = (shortcut: ParsedShortcut, modKey: ModKey): PhysicalChord => ({
  key: shortcut.shift ? unshiftedKey(shortcut.key) : shortcut.key,
  ctrl: shortcut.ctrl || (modKey === "ctrl" && shortcut.mod),
  meta: modKey === "meta" && shortcut.mod,
  alt: shortcut.alt,
  shift: shortcut.shift,
});

const chordId = (chord: PhysicalChord): string =>
  `${chord.ctrl ? "C" : ""}${chord.meta ? "M" : ""}${chord.alt ? "A" : ""}${chord.shift ? "S" : ""}:${chord.key}`;

// ── Conflicts ──────────────────────────────────────────────────

export interface KeybindingConflict {
  /** The row that wins — it comes first in the table. */
  readonly first: Keybinding;
  /** The row it shadows wherever both are live. */
  readonly second: Keybinding;
  /** The platforms the two collide on. */
  readonly platforms: ReadonlyArray<ModKey>;
}

const PLATFORMS: ReadonlyArray<ModKey> = ["meta", "ctrl"];

/**
 * Pairs of rows for different commands on the same physical chord whose
 * effective contexts (`effectiveWhen`) can hold together — only the first of
 * such a pair can fire there. Checked on `platform`, or on both platforms when
 * it is omitted. Rows that do not parse are skipped.
 */
export const findKeybindingConflicts = (
  keybindings: ReadonlyArray<Keybinding>,
  platform?: ModKey,
): ReadonlyArray<KeybindingConflict> => {
  const found = new Map<string, { first: number; second: number; platforms: Array<ModKey> }>();
  for (const target of platform === undefined ? PLATFORMS : [platform]) {
    const byChord = new Map<string, Array<{ index: number; when: WhenNode }>>();
    keybindings.forEach((binding, index) => {
      const parsed = parseShortcut(binding.shortcut);
      const when = parsed === null ? null : effectiveWhen(binding, parsed);
      if (parsed === null || when === null) {
        return;
      }
      const id = chordId(physicalChord(parsed, target));
      byChord.set(id, [...(byChord.get(id) ?? []), { index, when }]);
    });
    for (const rows of byChord.values()) {
      rows.forEach((first, i) => {
        for (const second of rows.slice(i + 1)) {
          const sameCommand =
            keybindings[first.index]!.command === keybindings[second.index]!.command;
          if (sameCommand || !nodesOverlap(first.when, second.when, target)) {
            continue;
          }
          const pair = `${first.index}:${second.index}`;
          const entry = found.get(pair) ?? {
            first: first.index,
            second: second.index,
            platforms: [],
          };
          entry.platforms.push(target);
          found.set(pair, entry);
        }
      });
    }
  }
  return [...found.values()]
    .sort((a, b) => a.first - b.first || a.second - b.second)
    .map((entry) => ({
      first: keybindings[entry.first]!,
      second: keybindings[entry.second]!,
      platforms: entry.platforms,
    }));
};

// ── Chords the system owns ─────────────────────────────────────

export interface ReservedChord {
  readonly shortcut: string;
  readonly reason: string;
}

const each = (shortcuts: ReadonlyArray<string>, reason: string): ReadonlyArray<ReservedChord> =>
  shortcuts.map((shortcut) => ({ shortcut, reason }));

const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const withArrows = (prefix: string): ReadonlyArray<string> => ARROWS.map((arrow) => prefix + arrow);

const SHARED_RESERVED: ReadonlyArray<ReservedChord> = [
  ...each(["Mod+Q"], "Quits the app"),
  ...each(["Mod+W"], "Closes the window"),
  ...each(["Mod+H"], "Hides the app"),
  ...each(["Mod+Alt+H"], "Hides the other apps"),
  ...each(["Mod+M"], "Minimises the window"),
  ...each(["Mod+R", "Mod+Shift+R"], "Reloads the window (the Electron default menu)"),
  ...each(["Mod+Alt+I", "Mod+Shift+I"], "Opens the developer tools"),
  ...each(["Mod+0", "Mod+=", "Mod+-", "Mod+Shift+="], "Zooms the page (the Electron default menu)"),
  ...each(["Mod+Z", "Mod+Shift+Z", "Mod+Y"], "Undo and redo"),
  ...each(["Mod+X", "Mod+C", "Mod+V", "Mod+A"], "Cut, copy, paste and select all"),
  ...each(["Mod+`"], "Cycles the app's windows"),
  ...each(["Mod+Tab", "Mod+Shift+Tab"], "Switches apps or tabs"),
  ...each(["Mod+Space", "Ctrl+Space"], "Search or input-source switching"),
  ...each(["Mod+Shift+/"], "Searches the Help menu on macOS"),
  ...each(
    [...withArrows("Mod+"), ...withArrows("Mod+Shift+"), "Mod+Backspace", "Mod+Delete"],
    "Moves, selects or deletes to the line or document edge",
  ),
  ...each(
    [...withArrows("Alt+"), "Alt+Shift+ArrowLeft", "Alt+Shift+ArrowRight", "Alt+Backspace"],
    "Moves, selects or deletes by word",
  ),
];

const MAC_RESERVED: ReadonlyArray<ReservedChord> = [
  ...each(["Ctrl+Mod+F"], "Toggles full screen"),
  ...each(["Ctrl+Mod+Q"], "Locks the screen"),
  ...each(["Ctrl+Mod+Space"], "Opens the emoji picker"),
  ...each(["Mod+Alt+D"], "Shows or hides the Dock"),
  ...each(["Mod+Alt+Escape"], "Opens Force Quit"),
  ...each(["Mod+Shift+3", "Mod+Shift+4", "Mod+Shift+5"], "Takes a screenshot"),
  ...each(
    [..."ABDEFHKNOPTVY"].map((letter) => `Ctrl+${letter}`),
    "Text editing in every macOS text field",
  ),
];

const OTHER_RESERVED: ReadonlyArray<ReservedChord> = [
  ...each(["F11"], "Toggles full screen"),
  ...each(["Alt+F4"], "Closes the window"),
  ...each(["Mod+Home", "Mod+End"], "Moves to the document edge"),
  ...each(["Mod+Alt+T"], "Opens a terminal on Linux desktops"),
  ...each(["Mod+Alt+L"], "Locks the screen on Linux desktops"),
  ...each(["Mod+Alt+D"], "Shows the desktop on Linux desktops"),
  ...each(["Mod+Alt+Delete"], "The system security screen"),
  ...each(withArrows("Mod+Alt+"), "Switches workspaces on Linux desktops"),
];

/** Chords the operating system, the text system or the Electron shell owns, per platform. */
export const SYSTEM_RESERVED_CHORDS: Readonly<Record<ModKey, ReadonlyArray<ReservedChord>>> = {
  meta: [...SHARED_RESERVED, ...MAC_RESERVED],
  ctrl: [...SHARED_RESERVED, ...OTHER_RESERVED],
};

/**
 * Chords the app takes over in one context, where it answers the key before
 * the shell or the text system can: `Mod+R` in the browser pane reloads the
 * page, not the window. In the window the listener's `preventDefault` keeps the
 * key from the default menu; inside a page the desktop shell swallows it
 * (`apps/desktop/src/main/browser/guestChords.ts`).
 *
 * `Alt+ArrowUp`/`Down` move the caret by paragraph, which only means anything
 * in a text field; the Changes pane steps through its files with them under a
 * clause that rules text fields and menus out (`CHANGES_PANE_KEYS`).
 *
 * `Mod+Z` undoes typing, which only means anything in a text field; outside
 * text fields, the terminal and the browser pane it undoes the latest sidebar
 * action (`SIDEBAR_UNDO_KEYS`).
 */
const TAKEN_OVER_CHORDS: ReadonlyArray<{ readonly shortcut: string; readonly when: string }> = [
  { shortcut: "Mod+R", when: "browserFocus" },
  { shortcut: "Alt+ArrowDown", when: CHANGES_PANE_KEYS },
  { shortcut: "Alt+ArrowUp", when: CHANGES_PANE_KEYS },
  { shortcut: "Mod+Z", when: SIDEBAR_UNDO_KEYS },
];

/**
 * Why `shortcut` is reserved on `platform`, or null when it is free — or when
 * `when` is the context in which the app takes that chord over.
 */
export const reservedChordReason = (
  shortcut: string,
  platform: ModKey,
  when?: string,
): string | null => {
  const parsed = parseShortcut(shortcut);
  if (parsed === null) {
    return null;
  }
  const id = chordId(physicalChord(parsed, platform));
  const takenOver = TAKEN_OVER_CHORDS.some((entry) => {
    const chord = parseShortcut(entry.shortcut);
    return entry.when === when && chord !== null && chordId(physicalChord(chord, platform)) === id;
  });
  if (takenOver) {
    return null;
  }
  const match = SYSTEM_RESERVED_CHORDS[platform].find((entry) => {
    const reserved = parseShortcut(entry.shortcut);
    return reserved !== null && chordId(physicalChord(reserved, platform)) === id;
  });
  return match?.reason ?? null;
};
