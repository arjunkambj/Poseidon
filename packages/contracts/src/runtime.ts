/**
 * The connector → server protocol.
 *
 * A connector never talks about its own CLI. It translates whatever its harness
 * emits — NDJSON frames, a transcript file, a permission hook — into the events
 * below, and everything downstream (the ingestion reactor, the projections, the
 * renderer) is written against these names only. That is what lets a second
 * connector be added without touching the server or the UI.
 *
 * Every variant carries the same envelope (`RuntimeEventEnvelope`) so that an
 * event can always be attributed to a connector instance, a thread and, where
 * it applies, a turn, an item or a pending request. `raw` is the escape hatch:
 * the untranslated frame, kept for debugging and mandatory on `event.unmapped`,
 * the variant a connector emits when it sees something it does not understand
 * yet. Dropping such frames silently would make harness changes invisible.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { ApprovalDecision, ApprovalKind, Effort, ItemKind, RuntimeMode } from "./enums";
import { ConnectorInstanceId, EventId, ItemId, RequestId, ThreadId, TurnId } from "./ids";

// ── Shared value objects ───────────────────────────────────────

/**
 * A file the user attached to a turn, already written to the attachments dir.
 * `mime` is optional because a plain path drop carries no declared type.
 *
 * A *reference*, never the bytes: an attachment travels inside
 * `thread.turn.start` and lands in the event log, which is replayed on every
 * boot and streamed to every client — an inlined screenshot would be re-sent
 * forever. The file lives under `<attachments>/<threadId>/` and comes back
 * through `attachments.read`. `name` is what the user called it before
 * staging renamed it, `sha256` identifies the content, and both are optional
 * so a producer that only knows a path stays valid.
 *
 * It lives here rather than beside the commands because both sides need it:
 * the command that starts a turn and the `user_message` row that turn mints.
 */
export const Attachment = Schema.Struct({
  path: NonEmptyString,
  mime: Schema.optional(NonEmptyString),
  name: Schema.optional(NonEmptyString),
  size: Schema.optional(NonNegativeInt),
  sha256: Schema.optional(NonEmptyString),
});
export type Attachment = typeof Attachment.Type;

/**
 * A skill or plugin the user picked from the composer's `@` or `$` menu. A
 * *name*, not a body: the harness owns what the skill or plugin is, and the
 * connector decides how the reference reaches it in the prompt. Like
 * `Attachment`, both the command that starts a turn and the `user_message`
 * row it mints carry it.
 */
export const TurnReference = Schema.Struct({
  kind: Schema.Literals(["skill", "plugin"]),
  name: NonEmptyString,
});
export type TurnReference = typeof TurnReference.Type;

/** Lifecycle of one timeline item, and of one subagent task. */
export const ItemStatus = Schema.Literals(["in_progress", "completed", "failed"]);
export type ItemStatus = typeof ItemStatus.Type;

/** What a file change did to the path. */
export const FileChangeKind = Schema.Literals(["create", "edit", "delete"]);
export type FileChangeKind = typeof FileChangeKind.Type;

/** One entry of the model's own checklist, as `todo_write` writes it. */
export const Todo = Schema.Struct({
  todoId: NonEmptyString,
  text: NonEmptyString,
  status: Schema.Literals(["pending", "in_progress", "completed"]),
});
export type Todo = typeof Todo.Type;

/** One answerable choice on an `ask_user_question` card. */
export const UserQuestionOption = Schema.Struct({
  optionId: NonEmptyString,
  label: NonEmptyString,
  description: Schema.optional(Schema.String),
});
export type UserQuestionOption = typeof UserQuestionOption.Type;

/**
 * One question the model is blocked on. `multiSelect` decides whether the card
 * renders radio buttons or checkboxes; `freeform` allows an answer that is not
 * one of the offered options.
 */
export const UserQuestion = Schema.Struct({
  questionId: NonEmptyString,
  question: NonEmptyString,
  header: Schema.optional(Schema.String),
  options: Schema.Array(UserQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean),
  freeform: Schema.optional(Schema.Boolean),
});
export type UserQuestion = typeof UserQuestion.Type;

/** The user's reply to one `UserQuestion`. */
export const UserQuestionAnswer = Schema.Struct({
  questionId: NonEmptyString,
  optionIds: Schema.Array(NonEmptyString),
  text: Schema.optional(Schema.String),
});
export type UserQuestionAnswer = typeof UserQuestionAnswer.Type;

/** The MCP server and tool an `mcp_tool` request calls, as its connector names them. */
export const McpToolRef = Schema.Struct({
  server: NonEmptyString,
  tool: NonEmptyString,
});
export type McpToolRef = typeof McpToolRef.Type;

/**
 * A pending permission decision. `input` is the harness's own tool input,
 * unmodelled on purpose: the approval card shows a rendering of it, and the
 * permission engine matches patterns against `toolName` plus the fields it
 * knows. `patternSuggestion` is what "allow always" would persist, in
 * Poseidon's own pattern vocabulary (`@poseidon/shared/permissionPattern`) —
 * the connector maps its harness's tool onto it — and is editable in the card
 * before it is accepted. `mcpTool` names the server and tool of an MCP call so
 * an `Mcp(server.tool)` rule can match it; it is optional because requests
 * persisted before it existed do not carry it.
 */
export const ApprovalRequest = Schema.Struct({
  requestId: RequestId,
  kind: ApprovalKind,
  toolName: NonEmptyString,
  input: Schema.Unknown,
  patternSuggestion: Schema.optional(Schema.String),
  mcpTool: Schema.optional(McpToolRef),
  description: Schema.String,
});
export type ApprovalRequest = typeof ApprovalRequest.Type;

/** Whether a capability can change mid-turn, mid-session, or only on restart. */
export const CapabilitySwitch = Schema.Literals(["per-turn", "in-session", "restart"]);
export type CapabilitySwitch = typeof CapabilitySwitch.Type;

/**
 * What this connector's harness can actually do. The renderer reads it instead
 * of knowing which harness it is talking to: the header controls decide from
 * `modelSwitch`/`effortSwitch` whether a pick applies now or next turn, the mode
 * picker offers only `runtimeModes`, and the composer refuses attachments when
 * `images` is false.
 *
 * - `interrupt` — what stopping cancels: only the running `turn`, or the whole
 *   `session` (a harness whose one process serves every turn).
 * - `rollback` — the harness can rewind its own conversation to an earlier
 *   turn. Poseidon's checkpoints are git and do not depend on it.
 * - `compaction` — the connector can ask the harness to compact its context on
 *   demand. Compaction the harness does by itself needs no flag.
 * - `questions` — the harness can put a question to the user mid-turn.
 * - `runtimeModes` — the modes a session can honour, never empty.
 * - `attachments` — what a turn can carry: only `images`, or any `files`.
 *
 * - `steering` — a message sent while a turn runs can be delivered into that
 *   turn. The server copies the capabilities onto the thread's bound session,
 *   and the decider reads this flag there: `thread.turn.steer` is accepted
 *   only when it is true, and a harness without it takes the queue instead.
 *
 * - `stopTask` — one running subagent can be stopped while its turn goes on
 *   (`SessionHandle.stopTask`). Optional: a session bound before it existed
 *   has none, and absent reads as false.
 *
 * - `fork` — the harness can copy a session into a new one and leave the
 *   original untouched. The decider reads it on the source's bound session:
 *   a fork of the source's latest settled turn resumes that session with
 *   `fork: true` instead of carrying the conversation over as text.
 *
 * - `textGeneration` — the connector can write one piece of text in a
 *   one-shot, tool-less, read-only call outside any session
 *   (`ConnectorInstance.generateText`): commit messages, pull-request text,
 *   thread titles. Optional like `stopTask`: capabilities are copied into
 *   stored session events, and absent reads as false.
 */
export const ConnectorCapabilities = Schema.Struct({
  modelSwitch: CapabilitySwitch,
  effortSwitch: CapabilitySwitch,
  steering: Schema.Boolean,
  planMode: Schema.Boolean,
  subagents: Schema.Boolean,
  images: Schema.Boolean,
  resume: Schema.Boolean,
  fork: Schema.Boolean,
  interrupt: Schema.Literals(["turn", "session"]),
  rollback: Schema.Boolean,
  compaction: Schema.Boolean,
  questions: Schema.Boolean,
  runtimeModes: Schema.Array(RuntimeMode),
  attachments: Schema.Literals(["images", "files"]),
  stopTask: Schema.optional(Schema.Boolean),
  textGeneration: Schema.optional(Schema.Boolean),
});
export type ConnectorCapabilities = typeof ConnectorCapabilities.Type;

/**
 * One timeline row, complete as of this event. Items are sent whole rather than
 * as patches so that a late subscriber, a resnapshot and a replay all converge
 * on the same row. The optional sub-objects are keyed by `kind`: a
 * `command_execution` fills `command`, a `file_change` fills `fileChange`, and
 * so on.
 */
export const ItemSnapshot = Schema.Struct({
  itemId: ItemId,
  kind: ItemKind,
  status: ItemStatus,
  /**
   * The turn that produced the row. A resumed timeline is grouped by it —
   * without it a client that opens a thread and receives the snapshot has no
   * way to fold settled turns into their "worked for Ns" rows. Absent on rows
   * a connector emitted outside any turn.
   */
  turnId: Schema.optional(TurnId),
  parentItemId: Schema.optional(ItemId),
  text: Schema.optional(Schema.String),
  command: Schema.optional(
    Schema.Struct({
      cmd: NonEmptyString,
      cwd: Schema.optional(Schema.String),
      exitCode: Schema.optional(Schema.Int),
      output: Schema.optional(Schema.String),
    }),
  ),
  fileChange: Schema.optional(
    Schema.Struct({
      path: NonEmptyString,
      kind: FileChangeKind,
      diff: Schema.optional(Schema.String),
    }),
  ),
  tool: Schema.optional(
    Schema.Struct({
      name: NonEmptyString,
      server: Schema.optional(Schema.String),
      input: Schema.Unknown,
      output: Schema.optional(Schema.Unknown),
    }),
  ),
  /**
   * What the user attached to the turn this row records — `user_message` only.
   * References, so the row carries no bytes; a client fetches each one with
   * `attachments.read` when it wants to draw a thumbnail.
   */
  attachments: Schema.optional(Schema.Array(Attachment)),
  /** The skills and plugins the user referenced — `user_message` only. */
  references: Schema.optional(Schema.Array(TurnReference)),
  plan: Schema.optional(Schema.Struct({ markdown: Schema.String })),
  todos: Schema.optional(Schema.Array(Todo)),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
export type ItemSnapshot = typeof ItemSnapshot.Type;

// ── Envelope ───────────────────────────────────────────────────

/**
 * The untranslated frame this event came from. `source` names the stream, e.g.
 * `"cmd.ndjson"`, `"cmd.transcript"` or `"cmd.hook"`, so that a mismatch
 * between two overlapping sources can be traced after the fact.
 */
export const RuntimeEventRaw = Schema.Struct({
  source: NonEmptyString,
  method: Schema.optional(NonEmptyString),
  payload: Schema.Unknown,
});
export type RuntimeEventRaw = typeof RuntimeEventRaw.Type;

/** The fields every runtime event carries, whatever its type. */
export const RuntimeEventEnvelope = Schema.Struct({
  eventId: EventId,
  connectorInstanceId: ConnectorInstanceId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ItemId),
  requestId: Schema.optional(RequestId),
  raw: Schema.optional(RuntimeEventRaw),
});
export type RuntimeEventEnvelope = typeof RuntimeEventEnvelope.Type;

const envelope = RuntimeEventEnvelope.fields;

/** Builds one event variant: the envelope, a literal `type`, and its payload. */
const event = <const Type extends string, Payload extends Schema.Struct<Schema.Struct.Fields>>(
  type: Type,
  payload: Payload,
) => Schema.Struct({ ...envelope, type: Schema.Literal(type), payload });

// ── Payloads ───────────────────────────────────────────────────

/** Why a connector session is over. `crashed` is the one the supervisor retries. */
export const SessionEndReason = Schema.Literals(["stopped", "crashed", "interrupted"]);
export type SessionEndReason = typeof SessionEndReason.Type;

/** How a turn finished. Mapped from the harness's own stop reason and exit code. */
export const TurnStopReason = Schema.Literals(["end_turn", "interrupted", "error", "max_turns"]);
export type TurnStopReason = typeof TurnStopReason.Type;

/** Which stream a `content.delta` belongs to. */
export const ContentDeltaKind = Schema.Literals(["text", "reasoning", "tool_input"]);
export type ContentDeltaKind = typeof ContentDeltaKind.Type;

/** Connection state of one MCP server configured for the session. */
export const McpServerStatus = Schema.Literals(["connecting", "connected", "failed", "disabled"]);
export type McpServerStatus = typeof McpServerStatus.Type;

const SessionStartedEvent = event(
  "session.started",
  Schema.Struct({
    /**
     * Whatever the connector needs to resume this session later — for Command
     * Code `{ sessionId, transcriptPath, cwd, lastMessageId }`. Opaque here so
     * that the server can persist it without knowing any harness's shape.
     */
    sessionRef: Schema.Unknown,
    model: NonEmptyString,
    capabilities: ConnectorCapabilities,
  }),
);

const SessionEndedEvent = event(
  "session.ended",
  Schema.Struct({
    reason: SessionEndReason,
    exitCode: Schema.optional(Schema.Int),
  }),
);

const SessionWarningEvent = event("session.warning", Schema.Struct({ message: NonEmptyString }));

const TurnStartedEvent = event("turn.started", Schema.Struct({ turnId: TurnId }));

const TurnCompletedEvent = event(
  "turn.completed",
  Schema.Struct({ turnId: TurnId, stopReason: TurnStopReason }),
);

const TurnPlanProposedEvent = event(
  "turn.plan.proposed",
  Schema.Struct({
    turnId: TurnId,
    planMarkdown: Schema.String,
    planPath: Schema.optional(Schema.String),
  }),
);

const ItemPayload = Schema.Struct({ item: ItemSnapshot });

const ItemStartedEvent = event("item.started", ItemPayload);
const ItemUpdatedEvent = event("item.updated", ItemPayload);
const ItemCompletedEvent = event("item.completed", ItemPayload);

const ContentDeltaEvent = event(
  "content.delta",
  Schema.Struct({ itemId: ItemId, kind: ContentDeltaKind, delta: Schema.String }),
);

const RequestOpenedEvent = event("request.opened", Schema.Struct({ request: ApprovalRequest }));

const RequestResolvedEvent = event(
  "request.resolved",
  Schema.Struct({ requestId: RequestId, decision: ApprovalDecision }),
);

const UserInputRequestedEvent = event(
  "user-input.requested",
  Schema.Struct({ requestId: RequestId, questions: Schema.Array(UserQuestion) }),
);

const UserInputResolvedEvent = event(
  "user-input.resolved",
  Schema.Struct({ requestId: RequestId }),
);

/**
 * Subagent lifecycle. `taskId` is an `ItemId` because a task is also a timeline
 * row: the nested rows it owns point back at it through `parentItemId`.
 */
const TaskPayload = Schema.Struct({
  taskId: ItemId,
  parentItemId: Schema.optional(ItemId),
  title: NonEmptyString,
  model: Schema.optional(NonEmptyString),
  status: ItemStatus,
});

const TaskStartedEvent = event("task.started", TaskPayload);
const TaskUpdatedEvent = event("task.updated", TaskPayload);
const TaskCompletedEvent = event("task.completed", TaskPayload);

const UsageUpdatedEvent = event(
  "usage.updated",
  Schema.Struct({
    turnId: TurnId,
    input: NonNegativeInt,
    output: NonNegativeInt,
    cacheRead: NonNegativeInt,
    cacheWrite: NonNegativeInt,
    costUsd: Schema.optional(Schema.Number),
  }),
);

const ContextUpdatedEvent = event(
  "context.updated",
  Schema.Struct({ used: NonNegativeInt, limit: NonNegativeInt }),
);

const ModelChangedEvent = event(
  "model.changed",
  Schema.Struct({ model: NonEmptyString, effort: Schema.optional(Effort) }),
);

const McpStatusUpdatedEvent = event(
  "mcp.status.updated",
  Schema.Struct({
    servers: Schema.Array(Schema.Struct({ name: NonEmptyString, status: McpServerStatus })),
  }),
);

const RuntimeErrorEvent = event(
  "runtime.error",
  Schema.Struct({ message: NonEmptyString, fatal: Schema.Boolean }),
);

/**
 * A frame the connector recognised as belonging to the session but could not
 * translate. It has no payload of its own and `raw` is mandatory: the whole
 * point is to keep the unknown frame so that a harness change shows up in the
 * event log instead of vanishing.
 */
const EventUnmappedEvent = Schema.Struct({
  ...envelope,
  raw: RuntimeEventRaw,
  type: Schema.Literal("event.unmapped"),
  payload: Schema.Struct({}),
});

// ── The union ──────────────────────────────────────────────────

export const RuntimeEvent = Schema.Union([
  SessionStartedEvent,
  SessionEndedEvent,
  SessionWarningEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  TurnPlanProposedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  ContentDeltaEvent,
  RequestOpenedEvent,
  RequestResolvedEvent,
  UserInputRequestedEvent,
  UserInputResolvedEvent,
  TaskStartedEvent,
  TaskUpdatedEvent,
  TaskCompletedEvent,
  UsageUpdatedEvent,
  ContextUpdatedEvent,
  ModelChangedEvent,
  McpStatusUpdatedEvent,
  RuntimeErrorEvent,
  EventUnmappedEvent,
]);
export type RuntimeEvent = typeof RuntimeEvent.Type;

/**
 * The type tags of `RuntimeEvent`, as data. A test keeps this list and the
 * union's members in lockstep, so a variant can never be added to one without
 * the other.
 */
export const RuntimeEventType = Schema.Literals([
  "session.started",
  "session.ended",
  "session.warning",
  "turn.started",
  "turn.completed",
  "turn.plan.proposed",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.updated",
  "task.completed",
  "usage.updated",
  "context.updated",
  "model.changed",
  "mcp.status.updated",
  "runtime.error",
  "event.unmapped",
]);
export type RuntimeEventType = typeof RuntimeEventType.Type;

/** The `type` tag of each union member, in declaration order. */
export const runtimeEventTypes: ReadonlyArray<RuntimeEventType> = RuntimeEvent.members.map(
  (member) => member.fields.type.literal,
);
