/**
 * The integrated terminal on the wire.
 *
 * A terminal is a shell the server runs in a pseudo-terminal for one owner,
 * with the owner's workspace as its working directory. The owner is a thread —
 * its workspace is its worktree when it has one, its project's folder
 * otherwise — or, before any thread exists (the New task page), a project,
 * whose workspace is its folder (`TerminalOwner`). The client mints the
 * `TerminalId`, so `terminal.open` is idempotent and a client that comes back
 * to a thread reattaches to the same shell by id.
 *
 * A thread terminal's payloads and summary carry `threadId`, as they always
 * have; a project terminal's carry `projectId` in its place. When the New
 * task page starts a local thread — one working in the project's folder —
 * `terminal.adopt` hands the project's terminals to it, so a shell started
 * there carries on in the thread.
 *
 * A terminal can instead run one named script — a project script, or one
 * detected in a `package.json` — as its own process: the user's login shell
 * with `-c <command>` rather than an interactive shell. Its `running` and
 * `exited` are then the script's, the exit code is the script's own, and the
 * summary carries the script's id and name (`TerminalScript`) so a client
 * can tell which script a tab is running. The command itself is not kept in
 * the summary.
 *
 * Output is text, not bytes: the server decodes the pty's output as UTF-8 and
 * every length and offset here counts UTF-16 chars, the unit both ends' strings
 * are measured in.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { ProjectId, TerminalId, ThreadId } from "./ids";

// ── Limits both ends share ─────────────────────────────────────

/** Chars of recent output the server keeps per terminal, so a reattaching client sees it. */
export const TERMINAL_SCROLLBACK_CHARS = 1024 * 1024;

/** How long the server holds output back before sending it as one item, so a flood is not a frame per write. */
export const TERMINAL_BATCH_MS = 16;

/** The most chars one `output` item carries, so a flood cannot become one huge frame. */
export const TERMINAL_BATCH_CHARS = 64 * 1024;

/**
 * The budget on one `terminal.subscribe`, larger than the generic stream
 * budget because a busy shell produces many small items. A subscriber past it
 * is sent `resnapshot-required` instead of an ever-growing backlog.
 */
export const TERMINAL_STREAM_BUDGET_BYTES = 4 * 1024 * 1024;
export const TERMINAL_STREAM_BUDGET_ITEMS = 4096;

/**
 * Open terminals one owner — a thread, or a project — may hold, so a runaway
 * client cannot fork shells without end.
 */
export const TERMINALS_PER_OWNER = 8;

/** The most chars one `terminal.write` may carry: a large paste fits, an unbounded frame does not. */
export const TERMINAL_WRITE_MAX_CHARS = 1024 * 1024;

/** The most chars a script's command may have: any real one-liner fits. */
export const TERMINAL_SCRIPT_COMMAND_MAX_CHARS = 8 * 1024;

// ── Owner ──────────────────────────────────────────────────────

/**
 * The owner's half of every terminal shape: exactly one of `threadId` and
 * `projectId`. Each variant rules the other id out (`optional(Never)`), so a
 * value naming both — no client sends one — matches neither and is refused,
 * rather than read as whichever variant happens to come first.
 */
const byThread = { threadId: ThreadId, projectId: Schema.optional(Schema.Never) };
const byProject = { projectId: ProjectId, threadId: Schema.optional(Schema.Never) };

/**
 * Who a terminal belongs to: a thread, or a project with no thread yet. The
 * two are kept apart on purpose — a draft's thread id is never a project
 * terminal's owner, because the thread it becomes may run in a new worktree.
 */
export const TerminalOwner = Schema.Union([Schema.Struct(byThread), Schema.Struct(byProject)]);
export type TerminalOwner = typeof TerminalOwner.Type;

/** `fields` owned by a thread or by a project: the shape of every terminal payload. */
export const terminalOwned = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Union([
    Schema.Struct({ ...byThread, ...fields }),
    Schema.Struct({ ...byProject, ...fields }),
  ]);

/** Whether an owner is a thread; the other kind is a project. */
export const isThreadOwner = (
  owner: TerminalOwner,
): owner is Extract<TerminalOwner, { readonly threadId: ThreadId }> => owner.threadId !== undefined;

/** The owner a payload or summary names, and nothing else of it. */
export const terminalOwnerOf = (value: TerminalOwner): TerminalOwner =>
  isThreadOwner(value) ? { threadId: value.threadId } : { projectId: value.projectId };

const PROJECT_KEY_PREFIX = "project:";

/**
 * An owner as one string, for maps and atom families: a thread is its bare id
 * — the key the client's per-thread state has always used — and a project is
 * `project:<id>`. Ids are UUIDs, so the two can never meet.
 */
export const terminalOwnerKey = (owner: TerminalOwner): string =>
  isThreadOwner(owner) ? owner.threadId : `${PROJECT_KEY_PREFIX}${owner.projectId}`;

export const decodeTerminalOwnerKey = (key: string): TerminalOwner =>
  key.startsWith(PROJECT_KEY_PREFIX)
    ? { projectId: key.slice(PROJECT_KEY_PREFIX.length) as ProjectId }
    : { threadId: key as ThreadId };

// ── Shapes ─────────────────────────────────────────────────────

/** A terminal's grid, in character cells. The bounds keep a bad measure from reaching the pty. */
export const TerminalSize = Schema.Struct({
  cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
});
export type TerminalSize = typeof TerminalSize.Type;

/**
 * The script a terminal runs as its own process: an id the client keys it by
 * (a saved script's, or a detected one's) and the name its tab shows.
 */
export const TerminalScript = Schema.Struct({ id: NonEmptyString, name: NonEmptyString });
export type TerminalScript = typeof TerminalScript.Type;

/** A script as `terminal.open` is asked to launch it: its id and name, and the command to run. */
export const TerminalScriptLaunch = Schema.Struct({
  ...TerminalScript.fields,
  command: NonEmptyString.check(Schema.isMaxLength(TERMINAL_SCRIPT_COMMAND_MAX_CHARS)),
});
export type TerminalScriptLaunch = typeof TerminalScriptLaunch.Type;

const terminalSummaryFields = {
  title: NonEmptyString,
  cwd: NonEmptyString,
  pid: NonNegativeInt,
  ...TerminalSize.fields,
  status: Schema.Literals(["running", "exited"]),
  exitCode: Schema.NullOr(Schema.Int),
  createdAt: IsoDateTime,
  /** Set when the terminal runs a script rather than an interactive shell. */
  script: Schema.optional(TerminalScript),
};

/**
 * One terminal as the server knows it, with its owner's id beside its own. An
 * `exited` terminal stays listed, with its output, until the client closes it,
 * so the last thing a command printed is still readable after the shell has
 * gone.
 */
export const TerminalSummary = Schema.Union([
  Schema.Struct({ terminalId: TerminalId, ...byThread, ...terminalSummaryFields }),
  Schema.Struct({ terminalId: TerminalId, ...byProject, ...terminalSummaryFields }),
]);
export type TerminalSummary = typeof TerminalSummary.Type;

/**
 * One frame of a `terminal.subscribe` stream: a `snapshot` first, then
 * `output` as the shell writes it, `exited` when the shell ends, and
 * `resnapshot-required` when the subscriber fell behind its budget and has to
 * subscribe again.
 *
 * `offset` is the total number of chars the terminal has produced up to the
 * end of that item — for a snapshot, up to the end of the scrollback it
 * carries. The server subscribes to live output before it reads the
 * scrollback, so an `output` item can overlap the snapshot. A client drops any
 * `output` whose offset is at or below the offset it already holds, which is
 * what keeps the gap between subscribing and reading the snapshot from either
 * duplicating or losing output.
 */
export const TerminalStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    terminal: TerminalSummary,
    data: Schema.String,
    offset: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("output"),
    data: Schema.String,
    offset: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("exited"),
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.Int),
  }),
  Schema.Struct({
    kind: Schema.Literal("resnapshot-required"),
    reason: Schema.String,
  }),
]);
export type TerminalStreamItem = typeof TerminalStreamItem.Type;
