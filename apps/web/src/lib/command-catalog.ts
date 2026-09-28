/**
 * Every command the keymap can bind, as the user sees it: a title, the area it
 * belongs to, and whether the command palette offers it.
 *
 * The keymap itself (`DEFAULT_KEYBINDINGS`) says which chord fires a command;
 * this says what the command is called and where it is listed. The palette
 * offers the entries marked `palette` whose surface is mounted, grouped by
 * area. A command with no default chord (`mcp.open`, `chatWidth.cycle`) is still here, so it can
 * be found and bound.
 *
 * `palette: false` is for a command the palette already reaches another way,
 * or would only add noise with. The Navigation and Settings groups stand in
 * for their commands; the "New thread in …" row for the project it picks
 * stands in for `thread.newInProject`; the thread rows stand in for
 * `thread.jump.N` — each such row shows the command's chord. The rest are
 * `question.option.N` and the palette's own toggle.
 */

import { QUESTION_OPTION_COMMANDS, THREAD_JUMP_COMMANDS } from "@poseidon/contracts/keybindings";
import {
  type HoneyIcon,
  Add,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AppWindow,
  Brain,
  Check,
  CloudUpload,
  ChevronDown,
  ChevronsDown,
  ChevronUp,
  Edit,
  Eraser,
  FileCode,
  FolderAdd,
  GitBranch,
  GitCommit,
  GitDiff,
  Globe,
  Keyboard,
  LayoutAlignBottom,
  LayoutAlignRight,
  Lightning,
  ListChecks,
  ListOrdered,
  Lock,
  Maximize,
  OctagonX,
  Paperclip,
  Play,
  Refresh,
  Search,
  Server,
  Settings,
  SidebarLeft,
  Sparkles,
  SquarePen,
  Stop,
  Target,
  Trash,
  TextSize,
  UnfoldLess,
  UnfoldMore,
  ZoomIn,
  ZoomOut,
} from "@honeyicons/react";

/** The areas, in the order the palette and the shortcuts sheet list them. */
export const COMMAND_AREAS = [
  "General",
  "Threads",
  "Composer",
  "View",
  "Timeline",
  "Git",
  "Cards",
] as const;

export type CommandArea = (typeof COMMAND_AREAS)[number];

export interface CatalogCommand {
  readonly id: string;
  readonly title: string;
  readonly area: CommandArea;
  readonly description?: string;
  /** Whether the command palette offers it (when a mounted surface answers it). */
  readonly palette: boolean;
  /**
   * A clause over published flags that must also hold for the palette to offer
   * it — for a command whose surface is mounted before it has anything to do.
   * Focus keys are always false here: the palette holds the focus.
   */
  readonly paletteWhen?: string;
  readonly icon?: HoneyIcon;
}

const command = (
  area: CommandArea,
  id: string,
  title: string,
  icon: HoneyIcon | undefined,
  extra: Partial<Pick<CatalogCommand, "description" | "palette" | "paletteWhen">> = {},
): CatalogCommand => ({
  id,
  title,
  area,
  palette: true,
  ...(icon === undefined ? {} : { icon }),
  ...extra,
});

export const COMMAND_CATALOG: ReadonlyArray<CatalogCommand> = [
  // General
  command("General", "commandPalette.toggle", "Command palette", Search, { palette: false }),
  command("General", "shortcuts.open", "Keyboard shortcuts", Keyboard, {
    description: "Every command and its keys",
  }),
  command("General", "settings.open", "Settings", Settings, { palette: false }),
  command("General", "skills.open", "Skills", Sparkles, { palette: false }),
  command("General", "mcp.open", "MCP servers", Server, { palette: false }),
  command("General", "project.add", "Add project", FolderAdd),

  // Threads
  command("Threads", "thread.new", "New task", SquarePen, { palette: false }),
  command("Threads", "thread.newInProject", "New thread in this project", Add, {
    palette: false,
  }),
  ...THREAD_JUMP_COMMANDS.map((id, index) =>
    command("Threads", id, `Go to thread ${index + 1}`, undefined, {
      palette: false,
      description: "In sidebar order",
    }),
  ),
  command("Threads", "thread.previous", "Previous thread", ArrowUp),
  command("Threads", "thread.next", "Next thread", ArrowDown),
  command("Threads", "thread.rename", "Rename thread", Edit),
  command("Threads", "thread.archive", "Archive thread", Archive, {
    description: "Unarchives an archived thread",
  }),
  command("Threads", "thread.delete", "Delete thread", Trash, {
    description: "Asks before deleting",
  }),
  command("Threads", "nav.back", "Go back", ArrowLeft),
  command("Threads", "nav.forward", "Go forward", ArrowRight),

  // Composer
  command("Composer", "composer.planMode.toggle", "Toggle plan mode", ListChecks),
  command("Composer", "composer.runtimeMode.cycle", "Cycle runtime mode", Lock),
  command("Composer", "composer.modelPicker.open", "Choose model", Brain),
  command("Composer", "composer.effortPicker.open", "Choose effort", Lightning),
  command("Composer", "composer.effort.increase", "Raise effort", Lightning),
  command("Composer", "composer.effort.decrease", "Lower effort", Lightning),
  command("Composer", "composer.focus", "Focus composer", Target),
  command("Composer", "composer.queue", "Queue message", ListOrdered, {
    description: "Sends after the running turn",
  }),
  command("Composer", "thread.interrupt", "Stop turn", Stop, { paletteWhen: "turnRunning" }),
  command("Composer", "composer.attach", "Attach files", Paperclip),
  command("Composer", "composer.clearDraft", "Clear draft", Eraser),

  // View
  command("View", "sidebar.toggle", "Toggle sidebar", SidebarLeft),
  command("View", "dock.toggle", "Toggle right dock", LayoutAlignRight),
  command("View", "dock.changes", "Show changes", GitDiff),
  command("View", "dock.files", "Show files", FileCode),
  command("View", "browserPane.toggle", "Toggle browser", AppWindow),
  command("View", "terminal.toggle", "Toggle terminal", LayoutAlignBottom),
  // The browser pane's keys answer only while focus is in the pane, which the
  // palette never holds.
  command("View", "browser.focusUrl", "Focus browser address", Globe, { palette: false }),
  command("View", "browser.reload", "Reload browser page", Refresh, { palette: false }),
  command("View", "browser.back", "Browser back", ArrowLeft, { palette: false }),
  command("View", "browser.forward", "Browser forward", ArrowRight, { palette: false }),
  command("View", "font.increase", "Larger text", ZoomIn),
  command("View", "font.decrease", "Smaller text", ZoomOut),
  command("View", "font.reset", "Reset text size", TextSize),
  command("View", "chatWidth.cycle", "Cycle chat width", Maximize),

  // Timeline
  command("Timeline", "timeline.jumpToLatest", "Jump to latest", ChevronsDown),
  command("Timeline", "timeline.collapseAll", "Collapse all tool calls", UnfoldLess),
  command("Timeline", "timeline.expandAll", "Expand all tool calls", UnfoldMore),
  command("Timeline", "timeline.previousMessage", "Previous message", ChevronUp, {
    description: "Scrolls to your previous message",
  }),
  command("Timeline", "timeline.nextMessage", "Next message", ChevronDown, {
    description: "Scrolls to your next message",
  }),
  command("Timeline", "timeline.find", "Find in thread", Search, {
    description: "Searches this thread's messages and tool calls",
  }),

  // Changes — answered while the Changes pane lists files.
  command("View", "changes.nextFile", "Next changed file", ArrowDown),
  command("View", "changes.previousFile", "Previous changed file", ArrowUp),

  // Git
  command("Git", "git.commit", "Commit", GitCommit),
  command("Git", "git.push", "Commit & push", CloudUpload, {
    description: "Pushes straight away when there is nothing to commit",
  }),
  command("Git", "git.branchPicker", "Switch branch", GitBranch),

  // Cards
  command("Cards", "approval.allowOnce", "Allow once", Check),
  command("Cards", "approval.allowSession", "Allow for session", Check),
  command("Cards", "approval.allowAlways", "Always allow", Check),
  command("Cards", "approval.deny", "Deny", OctagonX),
  command("Cards", "plan.accept", "Accept plan", Check),
  command("Cards", "plan.acceptAndRun", "Accept plan and run", Play),
  command("Cards", "plan.revise", "Revise plan", Edit),
  ...QUESTION_OPTION_COMMANDS.map((id, index) =>
    command("Cards", id, `Pick option ${index + 1}`, undefined, {
      palette: false,
      description: "Toggles it in a multi-select question",
    }),
  ),
];

/**
 * Keys the composer handles itself and the keymap cannot rebind: Enter and
 * Shift+Enter depend on the `/` and `@` menus and on IME composition, so they
 * stay in the composer's own key handler. Shown in the shortcuts sheet so the
 * whole keyboard is in one place. Each chord is in keymap notation.
 */
export interface FixedKey {
  readonly keys: ReadonlyArray<string>;
  readonly title: string;
  readonly area: CommandArea;
}

export const FIXED_KEYS: ReadonlyArray<FixedKey> = [
  { keys: ["Enter"], title: "Send message", area: "Composer" },
  { keys: ["Shift+Enter"], title: "New line", area: "Composer" },
  {
    keys: ["ArrowUp", "ArrowDown", "Tab", "Shift+Tab"],
    title: "Move in the / and @ menus",
    area: "Composer",
  },
  { keys: ["Enter"], title: "Pick in the / and @ menus", area: "Composer" },
  { keys: ["Escape"], title: "Close the / and @ menu", area: "Composer" },
  {
    keys: ["ArrowUp", "ArrowDown"],
    title: "Recall a sent message (empty composer)",
    area: "Composer",
  },
];
