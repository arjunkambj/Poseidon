/**
 * The shipped keymap, and how a user's overrides are layered on it.
 *
 * The settings document stores only what the user changed
 * (`Settings.keybindings`), never a copy of the defaults — a copy would pin an
 * install to the defaults of the build that wrote it, and a shortcut added
 * later would never reach it. The rule is per command:
 *
 * - When the overrides mention a command at all, that command's default rows
 *   are dropped and its override rows are its bindings.
 * - A row whose command is `-X` (the VS Code convention) mentions `X` without
 *   binding it, so on its own it unbinds `X`. Its `shortcut` is `X`'s old
 *   chord, kept only so the stored row still reads as what was removed.
 * - The effective table is the override rows first, then the defaults of every
 *   command the overrides do not mention, in default order. Resolution is
 *   first-match, so an override shadows another command's default on the same
 *   chord.
 * - An override for a command the defaults do not know is kept; it is inert
 *   until something registers that command.
 */

import type { Keybinding } from "./settings";

/**
 * An interaction card answers plain keys only while it is the card on screen,
 * focus is outside a text field — where these keys are typing — and no dialog
 * or menu is in front of it. At most one card is pending at a time, so the
 * three families may share `1`, `2` and `3`.
 */
const APPROVAL_CARD = "approvalPending && !inputFocus && !dialogOpen";
const PLAN_CARD = "planPending && !inputFocus && !dialogOpen";
const QUESTION_CARD = "questionPending && !inputFocus && !dialogOpen";

/**
 * `question.option.1` … `question.option.9`: pick (or, in a multi-select,
 * toggle) option N of the question that holds focus, else of the first one.
 */
export const QUESTION_OPTION_COMMANDS: ReadonlyArray<string> = Array.from(
  { length: 9 },
  (_, index) => `question.option.${index + 1}`,
);

/** `thread.jump.1` … `thread.jump.9`: open the Nth thread in the sidebar. */
export const THREAD_JUMP_COMMANDS: ReadonlyArray<string> = Array.from(
  { length: 9 },
  (_, index) => `thread.jump.${index + 1}`,
);

/**
 * Chords that only make sense with a thread on screen. `Mod+[` and `Mod+]`
 * step the app's history everywhere but the browser pane, which keeps them for
 * its own page history.
 */
const THREAD = "threadOpen";
/**
 * The right dock's keys: live beside a thread, and on the New task page,
 * whose dock shows the picked project before any thread exists.
 */
const DOCK = "threadOpen || newTaskOpen";
const OUTSIDE_BROWSER = "!browserFocus";
const TIMELINE_KEYS = "threadOpen && !inputFocus";
/**
 * Find in thread: anywhere beside a thread but the terminal, the browser pane
 * and the Files tab, which each keep their own find, and not over a dialog or
 * menu, which the bar behind it would pull the focus out of.
 */
const THREAD_FIND = "threadOpen && !terminalFocus && !browserFocus && !filesFocus && !dialogOpen";

/**
 * The Changes pane's file keys: live only while the pane is the dock's tab,
 * and never in a text field or under a menu — `Alt+ArrowUp`/`Down` move the
 * caret there, and a menu owns its arrows. Outside both, the chord means
 * nothing to the system, which is why the reserved-chord check lets the pane
 * take it over under exactly this clause (`TAKEN_OVER_CHORDS` in
 * `@poseidon/client-runtime/keymap`).
 */
export const CHANGES_PANE_KEYS = "changesOpen && !inputFocus && !dialogOpen";

/**
 * `sidebar.undo` on `Mod+Z`: only where the chord undoes nothing else — never
 * in a text field (the composer included), the terminal or the browser pane,
 * nor under a dialog. The reserved-chord check lets the sidebar take the chord
 * over under exactly this clause (`TAKEN_OVER_CHORDS`).
 */
export const SIDEBAR_UNDO_KEYS = "!inputFocus && !terminalFocus && !browserFocus && !dialogOpen";

/**
 * The server-owned defaults. The keybindings page shows these as the baseline a
 * user's overrides are diffed against, so the list is the contract, not a
 * renderer constant. A row added here reaches every install, because the
 * stored document holds only overrides.
 *
 * The chords avoid the macOS system shortcuts, the Electron default menu
 * (reload, devtools, zoom, close, hide, quit), the standard text-editing
 * chords and each other in any context where two could be live at once;
 * `default-keymap.test.ts` in `@poseidon/client-runtime` fails the build when a
 * row breaks one of those rules. Font size takes `Mod+Alt+=`/`-`/`0` so page
 * zoom keeps `Mod+=`/`-`/`0`.
 */
export const DEFAULT_KEYBINDINGS: ReadonlyArray<Keybinding> = [
  // General
  { command: "commandPalette.toggle", shortcut: "Mod+K" },
  { command: "shortcuts.open", shortcut: "Mod+/" },
  { command: "settings.open", shortcut: "Mod+," },
  { command: "skills.open", shortcut: "Mod+Shift+S" },
  { command: "project.add", shortcut: "Mod+Shift+O" },
  { command: "sidebar.undo", shortcut: "Mod+Z", when: SIDEBAR_UNDO_KEYS },
  // Threads
  { command: "thread.new", shortcut: "Mod+N" },
  { command: "thread.newInProject", shortcut: "Mod+Shift+N" },
  ...THREAD_JUMP_COMMANDS.map((command, index) => ({
    command,
    shortcut: `Mod+${index + 1}`,
  })),
  { command: "thread.previous", shortcut: "Mod+Shift+[" },
  { command: "thread.next", shortcut: "Mod+Shift+]" },
  { command: "thread.rename", shortcut: "Mod+Alt+R", when: THREAD },
  { command: "thread.archive", shortcut: "Mod+Shift+A", when: THREAD },
  { command: "thread.delete", shortcut: "Mod+Alt+Backspace", when: THREAD },
  { command: "nav.back", shortcut: "Mod+[", when: OUTSIDE_BROWSER },
  { command: "nav.forward", shortcut: "Mod+]", when: OUTSIDE_BROWSER },
  // Composer
  { command: "composer.planMode.toggle", shortcut: "Shift+Tab", when: "composerFocus" },
  { command: "composer.runtimeMode.cycle", shortcut: "Mod+Shift+L" },
  { command: "composer.modelPicker.open", shortcut: "Mod+Shift+M" },
  { command: "composer.effortPicker.open", shortcut: "Mod+Shift+E" },
  { command: "composer.effort.increase", shortcut: "Mod+Shift+." },
  { command: "composer.effort.decrease", shortcut: "Mod+Shift+," },
  { command: "composer.focus", shortcut: "Mod+L", when: OUTSIDE_BROWSER },
  { command: "composer.queue", shortcut: "Mod+Enter" },
  // Escape cancels an edit in any other field — the browser pane's address
  // bar, the terminal — so there it must not also stop the turn.
  {
    command: "thread.interrupt",
    shortcut: "Escape",
    when: "turnRunning && !dialogOpen && (composerFocus || (!inputFocus && !approvalPending))",
  },
  { command: "composer.attach", shortcut: "Mod+U" },
  { command: "composer.clearDraft", shortcut: "Mod+Shift+Backspace", when: "composerFocus" },
  // View
  { command: "sidebar.toggle", shortcut: "Mod+B" },
  { command: "dock.toggle", shortcut: "Mod+Alt+B", when: DOCK },
  { command: "dock.changes", shortcut: "Mod+Shift+D", when: DOCK },
  { command: "dock.files", shortcut: "Mod+P", when: DOCK },
  { command: "browserPane.toggle", shortcut: "Mod+Shift+B" },
  { command: "terminal.toggle", shortcut: "Mod+J" },
  { command: "font.increase", shortcut: "Mod+Alt+=" },
  { command: "font.decrease", shortcut: "Mod+Alt+-" },
  { command: "font.reset", shortcut: "Mod+Alt+0" },
  // Timeline
  { command: "timeline.jumpToLatest", shortcut: "Mod+Shift+J", when: THREAD },
  { command: "timeline.collapseAll", shortcut: "Mod+Alt+[", when: THREAD },
  { command: "timeline.expandAll", shortcut: "Mod+Alt+]", when: THREAD },
  // Outside text fields, where Alt+Shift+Up/Down select to the paragraph edge.
  { command: "timeline.previousMessage", shortcut: "Alt+Shift+ArrowUp", when: TIMELINE_KEYS },
  { command: "timeline.nextMessage", shortcut: "Alt+Shift+ArrowDown", when: TIMELINE_KEYS },
  { command: "timeline.find", shortcut: "Mod+F", when: THREAD_FIND },
  // Changes
  { command: "changes.nextFile", shortcut: "Alt+ArrowDown", when: CHANGES_PANE_KEYS },
  { command: "changes.previousFile", shortcut: "Alt+ArrowUp", when: CHANGES_PANE_KEYS },
  // Git, answered by the thread header while a thread is open, and by the
  // New task page's header for the picked project's folder
  { command: "git.commit", shortcut: "Mod+Alt+C" },
  { command: "git.push", shortcut: "Mod+Alt+P" },
  { command: "git.branchPicker", shortcut: "Mod+Shift+G" },
  // The browser pane's own keys, live only while focus is in the pane — its
  // toolbar, or the page itself, whose keys the shell relays. `Mod+L`,
  // `Mod+[` and `Mod+]` are the composer's and the app history's everywhere
  // else, and `Mod+R` reloads the page instead of the window.
  { command: "browser.focusUrl", shortcut: "Mod+L", when: "browserFocus" },
  { command: "browser.reload", shortcut: "Mod+R", when: "browserFocus" },
  { command: "browser.back", shortcut: "Mod+[", when: "browserFocus" },
  { command: "browser.forward", shortcut: "Mod+]", when: "browserFocus" },
  // Cards
  { command: "approval.allowOnce", shortcut: "1", when: APPROVAL_CARD },
  { command: "approval.allowSession", shortcut: "2", when: APPROVAL_CARD },
  { command: "approval.allowAlways", shortcut: "3", when: APPROVAL_CARD },
  { command: "approval.deny", shortcut: "D", when: APPROVAL_CARD },
  { command: "approval.deny", shortcut: "Escape", when: APPROVAL_CARD },
  { command: "plan.accept", shortcut: "1", when: PLAN_CARD },
  { command: "plan.acceptAndRun", shortcut: "2", when: PLAN_CARD },
  { command: "plan.revise", shortcut: "3", when: PLAN_CARD },
  ...QUESTION_OPTION_COMMANDS.map((command, index) => ({
    command,
    shortcut: String(index + 1),
    when: QUESTION_CARD,
  })),
];

/** A chord held for a feature that is not built yet, and what it is for. */
export interface ReservedKeybinding extends Keybinding {
  readonly for: string;
}

/**
 * Chords promised to features still being built, so nothing shipped takes them
 * first. They are not bindings — nothing dispatches them — but the default-
 * keymap test treats each as one, failing when a default collides with it in
 * an overlapping context. A feature that lands moves its row into
 * `DEFAULT_KEYBINDINGS` and drops it here.
 *
 * Two areas are held by rule rather than by row. Chords whose clause is
 * `terminalFocus` belong to the terminal to choose, and must still pass the
 * collision test. `@`, `#`, `$` and `/` are characters the composer's triggers
 * read, never bindings; the test refuses a plain chord on any of them.
 */
export const RESERVED_KEYBINDINGS: ReadonlyArray<ReservedKeybinding> = [
  {
    command: "composer.steer",
    shortcut: "Mod+Shift+Enter",
    for: "Steer the running turn with the draft",
  },
];

/**
 * The table every install stored before the document held overrides — the
 * defaults of that build, verbatim. Frozen: it describes what old documents
 * contain, so it must never follow a change to `DEFAULT_KEYBINDINGS`.
 */
export const LEGACY_DEFAULT_KEYBINDINGS: ReadonlyArray<Keybinding> = Object.freeze([
  { command: "thread.new", shortcut: "Cmd+N" },
  { command: "commandPalette.toggle", shortcut: "Cmd+K" },
  { command: "composer.queue", shortcut: "Cmd+Enter" },
  { command: "thread.interrupt", shortcut: "Escape" },
  { command: "browserPane.toggle", shortcut: "Cmd+Shift+B" },
  { command: "sidebar.toggle", shortcut: "Cmd+B" },
  { command: "skills.open", shortcut: "Cmd+Shift+S" },
  { command: "settings.open", shortcut: "Cmd+," },
  // Appended to stored tables by the 0006_terminal_keybinding migration.
  { command: "terminal.toggle", shortcut: "Cmd+J" },
]);

const UNBIND_PREFIX = "-";

/** True for a `-X` row: it unbinds `X` rather than binding anything. */
export const isUnbindRow = (row: Keybinding): boolean =>
  row.command.length > UNBIND_PREFIX.length && row.command.startsWith(UNBIND_PREFIX);

/** The command a row is about — `X` for both an `X` row and a `-X` row. */
const subjectOf = (row: Keybinding): string =>
  isUnbindRow(row) ? row.command.slice(UNBIND_PREFIX.length) : row.command;

/** A row with no `when: undefined` key, so it compares and stores cleanly. */
const clean = (row: Keybinding): Keybinding =>
  row.when === undefined
    ? { command: row.command, shortcut: row.shortcut }
    : { command: row.command, shortcut: row.shortcut, when: row.when };

const sameRow = (a: Keybinding, b: Keybinding): boolean =>
  a.command === b.command && a.shortcut === b.shortcut && a.when === b.when;

const sameRows = (a: ReadonlyArray<Keybinding>, b: ReadonlyArray<Keybinding>): boolean =>
  a.length === b.length && a.every((row, i) => sameRow(row, b[i]!));

/** Rows grouped by command, in order of first appearance. */
const byCommand = (table: ReadonlyArray<Keybinding>): Map<string, Array<Keybinding>> => {
  const groups = new Map<string, Array<Keybinding>>();
  for (const row of table) {
    const group = groups.get(row.command);
    if (group === undefined) {
      groups.set(row.command, [row]);
    } else {
      group.push(row);
    }
  }
  return groups;
};

/** The one row that unbinds `command`, carrying its old chord for display. */
const unbindRow = (command: string, shortcut: string): Keybinding => ({
  command: `${UNBIND_PREFIX}${command}`,
  shortcut,
});

/**
 * The table to dispatch against: the override rows (removals excluded) first,
 * then the defaults of every command the overrides do not mention.
 */
export const resolveKeymap = (
  defaults: ReadonlyArray<Keybinding>,
  overrides: ReadonlyArray<Keybinding>,
): ReadonlyArray<Keybinding> => {
  const overridden = new Set(overrides.map(subjectOf));
  return [
    ...overrides.filter((row) => !isUnbindRow(row)).map(clean),
    ...defaults.filter((row) => !overridden.has(row.command)),
  ];
};

/**
 * The overrides that turn `defaults` into `effective` — what the editor saves.
 * A command whose rows equal its defaults emits nothing, one whose rows differ
 * emits all of them, and a default command left with no rows emits one `-X`
 * row. Order within a command is kept; order across commands is not, since
 * `resolveKeymap` always puts overrides first.
 */
export const diffKeymap = (
  defaults: ReadonlyArray<Keybinding>,
  effective: ReadonlyArray<Keybinding>,
): ReadonlyArray<Keybinding> => {
  const shipped = byCommand(defaults);
  const wanted = byCommand(effective.map(clean));
  const changed = [...wanted].flatMap(([command, rows]) => {
    const baseline = shipped.get(command);
    return baseline !== undefined && sameRows(rows, baseline) ? [] : rows;
  });
  const removed = [...shipped]
    .filter(([command]) => !wanted.has(command))
    .map(([command, rows]) => unbindRow(command, rows[0]!.shortcut));
  return [...changed, ...removed];
};

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  cmd: "mod",
  meta: "mod",
  control: "ctrl",
  option: "alt",
  esc: "escape",
  return: "enter",
};

/** A chord's tokens, aliases folded and order ignored: `Cmd+Enter` is `Mod+Enter`. */
const chordKey = (shortcut: string): string =>
  shortcut
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .map((token) => MODIFIER_ALIASES[token] ?? token)
    .sort()
    .join("+");

/**
 * A kept legacy row with no clause, on the chord a default of its command
 * binds, takes that default's clause. The old keymap had no clauses, so such
 * a row is the default the user kept while changing something else; left
 * unscoped it would, as an override listed first, shadow the rows the new
 * clause keeps it apart from — an unscoped `Escape` for `thread.interrupt`
 * would stop the turn where an approval card now denies.
 */
const withDefaultClause = (row: Keybinding): Keybinding => {
  if (row.when !== undefined) {
    return row;
  }
  const scoped = DEFAULT_KEYBINDINGS.find(
    (entry) =>
      entry.command === row.command &&
      entry.when !== undefined &&
      chordKey(entry.shortcut) === chordKey(row.shortcut),
  );
  return scoped === undefined ? row : { ...row, when: scoped.when };
};

/**
 * Turns a full table stored before the document held overrides into
 * overrides. Rows are compared by exact string equality, which is sound
 * because the recorder of that build always wrote the canonical `Cmd+…` form
 * (today's writes `Mod+…`; the matcher reads both).
 *
 * - A legacy command whose rows are exactly its legacy default gets no
 *   override, so it follows the defaults from now on.
 * - A legacy command missing from the table was removed by the user, and gets
 *   a `-X` row so it stays removed.
 * - A legacy command with any other rows keeps them as its replacement.
 * - Rows for any other command are kept.
 * - A kept row with no clause, on a chord a default of its command binds
 *   with a clause, takes that clause (`withDefaultClause`).
 *
 * An empty table maps to no overrides: the renderer already showed the
 * defaults for one, so nothing the user sees changes.
 */
export const migrateLegacyKeybindingTable = (
  table: ReadonlyArray<Keybinding>,
): ReadonlyArray<Keybinding> => {
  if (table.length === 0) {
    return [];
  }
  const stored = byCommand(table.map(clean));
  const followsDefault = new Set<string>();
  const removed: Array<Keybinding> = [];
  for (const [command, rows] of byCommand(LEGACY_DEFAULT_KEYBINDINGS)) {
    const current = stored.get(command);
    if (current === undefined) {
      removed.push(unbindRow(command, rows[0]!.shortcut));
    } else if (sameRows(current, rows)) {
      followsDefault.add(command);
    }
  }
  // Kept in table order: resolution is first-match, so the rows that survive
  // keep the precedence they had between themselves.
  const kept = table.map(clean).filter((row) => !followsDefault.has(row.command));
  return [...kept.map(withDefaultClause), ...removed];
};
