/**
 * The decider: `command + stream state → events`, and nothing else.
 *
 * Pure — no clock, no I/O, no id minting of its own. The engine hands it the
 * folded aggregate state, the cross-aggregate facts it may check (`ctx`), and
 * the means to stamp events (`env`). Tests drive it with fixed ids and a fixed
 * clock, which is why a scripted conversation replays byte-identically.
 *
 * A rejection is a result, not an exception: the command receipts as
 * `rejected` and nothing is appended.
 */

import { isAbsolute } from "node:path";

import { DEFAULT_RUNTIME_MODE } from "@poseidon/contracts/enums";
import type { Effort, RuntimeMode } from "@poseidon/contracts/enums";
import type { EventId, ItemId, ProjectId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import { threadLocksConnector } from "@poseidon/contracts/orchestration";
import type {
  Actor,
  Command,
  OrchestrationEvent,
  StreamKind,
} from "@poseidon/contracts/orchestration";
import type { PermissionScope } from "@poseidon/contracts/settings";
import type { PlannedEvent } from "../persistence/EventStore";
import { resolveFork } from "./forkSeed";
import type { ProjectDoc, ThreadDoc } from "./state";
import { userMessageItem } from "./userMessageItem";

/** What one accepted command may write besides its events. */
export interface NewPermissionRule {
  readonly scope: PermissionScope;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  readonly pattern: string;
  readonly decision: "allow" | "deny";
}

export type DecideResult =
  | {
      readonly accepted: true;
      readonly events: ReadonlyArray<PlannedEvent>;
      readonly permissionRule?: NewPermissionRule;
    }
  | { readonly accepted: false; readonly reason: string };

/** The stream a command's events belong to. */
export const streamOf = (
  command: Command,
): {
  readonly streamKind: StreamKind;
  readonly streamId: string;
} =>
  command.type === "project.create" || command.type === "project.remove"
    ? { streamKind: "project", streamId: command.projectId }
    : { streamKind: "thread", streamId: command.threadId };

/**
 * The non-stream facts a decider may check, gathered by the engine inside the
 * command's transaction.
 */
export interface DeciderContext {
  readonly projectExists: (projectId: ProjectId) => boolean;
  readonly workspaceRootTaken: (root: string, exceptProjectId?: ProjectId) => boolean;
  /**
   * Whether a sibling thread that shares this thread's workspace root has a
   * checkpoint restore in flight. The git work runs over that whole directory,
   * so the exclusion covers every thread writing there even though
   * `restoring` is per-thread: all the project's local threads share the
   * project's root, and all the threads of one worktree share that. A thread
   * in another directory is not held up.
   */
  readonly restoreInFlight: (thread: ThreadDoc) => boolean;
  /** Settings defaults for a thread whose create command did not choose them. */
  readonly defaultModel: string | null;
  readonly defaultEffort: Effort | null;
  readonly defaultRuntimeMode: RuntimeMode | null;
  /** The thread a forking `thread.create` names, or `null` when it does not exist. */
  readonly forkSource?: ThreadDoc | null;
}

/** Id and clock minting, injected so tests can fix both. */
export interface DecideEnv {
  readonly now: string;
  readonly nextEventId: () => EventId;
  readonly nextTurnId: () => TurnId;
  readonly nextItemId: () => ItemId;
}

const rejected = (reason: string): DecideResult => ({ accepted: false, reason });
const accepted = (
  events: ReadonlyArray<PlannedEvent>,
  permissionRule?: NewPermissionRule,
): DecideResult => ({
  accepted: true,
  events,
  ...(permissionRule === undefined ? {} : { permissionRule }),
});

const event =
  (env: DecideEnv, command: Command, streamKind: StreamKind, streamId: string) =>
  <Type extends OrchestrationEvent["type"]>(
    type: Type,
    payload: Extract<OrchestrationEvent, { type: Type }>["payload"],
    actor: Actor = "user",
  ): PlannedEvent =>
    ({
      eventId: env.nextEventId(),
      streamKind,
      streamId,
      occurredAt: env.now,
      commandId: command.commandId,
      correlationId: command.commandId,
      actor,
      type,
      payload,
    }) as PlannedEvent;

type Emit = ReturnType<typeof event>;

/** What the user typed, as the two turn commands carry it. */
type TurnText = Extract<Command, { type: "thread.turn.start" | "thread.turn.steer" }>;

/**
 * Skill and plugin references ride on every event that holds the turn, and
 * are left off when there are none, as attachments are on the row.
 */
const referencesOf = (command: TurnText) =>
  (command.references ?? []).length === 0 ? {} : { references: command.references };

/**
 * Why an existing thread may not take a message now, or `null` when it may.
 * Shared by `thread.turn.start` and `thread.turn.steer`: a steered message is
 * work on the worktree like any other, so it is barred for the same reasons.
 */
const turnBarred = (thread: ThreadDoc, ctx: DeciderContext): string | null => {
  if (thread.status === "archived") {
    return `thread ${thread.threadId} is archived`;
  }
  // A restore is rewriting the worktree right now: `git clean -fd` would
  // delete whatever the turn wrote while it ran. The directory is shared by
  // every thread working in it, so a sibling's restore bars this turn too.
  if (thread.restoring) {
    return `thread ${thread.threadId} is restoring a checkpoint`;
  }
  if (ctx.restoreInFlight(thread)) {
    return `another thread in project ${thread.projectId} is restoring a checkpoint`;
  }
  return null;
};

const queueMessage = (emit: Emit, env: DecideEnv, command: TurnText): PlannedEvent =>
  emit("thread.message.queued", {
    message: {
      queuedMessageId: env.nextItemId(),
      text: command.text,
      attachments: command.attachments,
      mentions: command.mentions,
      ...referencesOf(command),
      queuedAt: env.now,
    },
  });

/**
 * The user's own row. Nothing else mints it: connectors deliberately emit
 * nothing for a user text message (their translators say so), so without this
 * the timeline showed the answers and never the questions.
 */
const userMessage = (emit: Emit, env: DecideEnv, command: TurnText, turnId: TurnId): PlannedEvent =>
  emit("thread.item.upserted", {
    turnId,
    item: userMessageItem(env.nextItemId(), turnId, command),
  });

const startTurn = (emit: Emit, env: DecideEnv, command: TurnText): ReadonlyArray<PlannedEvent> => {
  const turnId = env.nextTurnId();
  return [
    emit("thread.turn.requested", {
      turnId,
      text: command.text,
      attachments: command.attachments,
      mentions: command.mentions,
      ...referencesOf(command),
    }),
    userMessage(emit, env, command, turnId),
  ];
};

export const decide = (
  command: Command,
  state: { readonly project: ProjectDoc | null; readonly thread: ThreadDoc | null },
  ctx: DeciderContext,
  env: DecideEnv,
): DecideResult => {
  const { streamKind, streamId } = streamOf(command);
  const emit = event(env, command, streamKind, streamId);
  const project = state.project;
  const thread = state.thread;

  switch (command.type) {
    case "project.create": {
      if (project !== null && !project.removed) {
        return rejected(`project ${command.projectId} already exists`);
      }
      if (ctx.workspaceRootTaken(command.workspaceRoot, command.projectId)) {
        return rejected(`workspace root ${command.workspaceRoot} is already a project`);
      }
      return accepted([
        emit("project.created", {
          projectId: command.projectId,
          name: command.name,
          workspaceRoot: command.workspaceRoot,
        }),
      ]);
    }

    case "project.remove": {
      if (project === null || project.removed) {
        return rejected(`project ${command.projectId} does not exist`);
      }
      return accepted([emit("project.removed", { projectId: command.projectId })]);
    }

    case "thread.create": {
      if (!ctx.projectExists(command.projectId)) {
        return rejected(`project ${command.projectId} does not exist`);
      }
      if (thread !== null && !thread.deleted) {
        return rejected(`thread ${command.threadId} already exists`);
      }
      // The worktree becomes the thread's workspace root: its session, its
      // checkpoints and its diff run there, so it must name one place however
      // the server's own working directory changes.
      if (command.worktree !== undefined && !isAbsolute(command.worktree.path)) {
        return rejected(`worktree path ${command.worktree.path} is not absolute`);
      }
      const fork = command.fork === undefined ? null : resolveFork(command, ctx.forkSource ?? null);
      if (typeof fork === "string") {
        return rejected(fork);
      }
      const patch = fork?.patch ?? command.settings ?? {};
      const model = patch.model ?? ctx.defaultModel;
      if (model === null) {
        return rejected(
          "no model is configured — pick a default in Settings → General → New thread defaults",
        );
      }
      // The command patch first, then "New thread defaults", then the built-in
      // fallback. All three of the settings document's defaults are read the
      // same way: a panel that writes a value the decider ignores is worse
      // than no panel at all.
      const effort = patch.effort ?? ctx.defaultEffort;
      return accepted([
        emit("thread.created", {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title ?? fork?.title ?? "New thread",
          settings: {
            model,
            runtimeMode: patch.runtimeMode ?? ctx.defaultRuntimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode: patch.interactionMode ?? "default",
            ...(effort === null || effort === undefined ? {} : { effort }),
            ...(patch.connectorInstanceId === undefined
              ? {}
              : { connectorInstanceId: patch.connectorInstanceId }),
          },
          ...(command.worktree === undefined ? {} : { worktree: command.worktree }),
          ...(fork === null ? {} : { fork: fork.fork }),
        }),
      ]);
    }

    case "thread.rename": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      return accepted([emit("thread.renamed", { title: command.title })]);
    }

    case "thread.archive": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.status === "archived") {
        return rejected(`thread ${command.threadId} is already archived`);
      }
      return accepted([emit("thread.archived", {})]);
    }

    case "thread.unarchive": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.status !== "archived") {
        return rejected(`thread ${command.threadId} is not archived`);
      }
      return accepted([emit("thread.unarchived", {})]);
    }

    case "thread.done.mark": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.status === "archived") {
        return rejected(`thread ${command.threadId} is archived`);
      }
      return accepted([emit("thread.done.marked", {})]);
    }

    case "thread.done.clear": {
      // Accepted whether or not the thread was marked: a thread that went to
      // Done on its own did so on the client (`autoDoneAfterDays`), which the
      // server never sees, and clearing it is how opening it brings it back.
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      return accepted([emit("thread.done.cleared", {})]);
    }

    case "thread.delete": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      return accepted([emit("thread.deleted", {})]);
    }

    case "thread.turn.start": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      const barred = turnBarred(thread, ctx);
      if (barred !== null) {
        return rejected(barred);
      }
      if (thread.currentTurn !== null) {
        // An interrupt that has not settled yet always queues, whatever the
        // caller asked for: the connector is still stopping, so a turn sent
        // now comes back "busy". The queue drains on `turn.completed`, which
        // is exactly when the connector is free again.
        if (!command.queued && !thread.interrupting) {
          return rejected("a turn is already running; send with queued: true to queue it");
        }
        return accepted([queueMessage(emit, env, command)]);
      }
      return accepted(startTurn(emit, env, command));
    }

    case "thread.turn.steer": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      const barred = turnBarred(thread, ctx);
      if (barred !== null) {
        return rejected(barred);
      }
      // The turn ended while the user was typing: the message starts the next
      // one, exactly as an unqueued send would, rather than being refused.
      if (thread.currentTurn === null) {
        return accepted(startTurn(emit, env, command));
      }
      // A turn that is stopping cannot take anything more; the queue drains
      // on its `turn.completed`, as it does for a send.
      if (thread.interrupting) {
        return accepted([queueMessage(emit, env, command)]);
      }
      // Only a harness that said it can steer is steered, and one that said
      // it cannot is refused. Not knowing yet — the session still starting
      // for the thread's first turn, or bound before capabilities were
      // recorded — is not a refusal: the message waits on the queue, as it
      // would for a harness that cannot steer.
      const steering = thread.session?.capabilities?.steering;
      if (steering === false) {
        return rejected("this thread's harness cannot take a message mid-turn; queue it instead");
      }
      if (steering !== true) {
        return accepted([queueMessage(emit, env, command)]);
      }
      // No user row here: the provider reactor writes it once the message
      // has reached the turn. A steer that misses goes back through the
      // queue, and the turn it starts writes the row there instead.
      return accepted([
        emit("thread.turn.steered", {
          turnId: thread.currentTurn.turnId,
          text: command.text,
          attachments: command.attachments,
          mentions: command.mentions,
          ...referencesOf(command),
        }),
      ]);
    }

    case "thread.turn.interrupt": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.currentTurn === null) {
        return rejected(`thread ${command.threadId} has no running turn`);
      }
      if (thread.interrupting) {
        return rejected(`thread ${command.threadId} is already stopping`);
      }
      return accepted([emit("thread.turn.interrupted", { turnId: thread.currentTurn.turnId })]);
    }

    case "thread.task.stop": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.session?.capabilities?.stopTask !== true) {
        return rejected(`thread ${command.threadId}'s harness cannot stop a subagent`);
      }
      // Only a task of the running turn is still running: one an ended turn
      // left open has nothing behind it to stop.
      const task = thread.items.find((item) => item.itemId === command.itemId);
      if (
        task?.kind !== "task" ||
        task.status !== "in_progress" ||
        thread.currentTurn === null ||
        (task.turnId !== undefined && task.turnId !== thread.currentTurn.turnId)
      ) {
        return rejected(`${command.itemId} is not a running subagent`);
      }
      return accepted([emit("thread.task.stopRequested", { itemId: command.itemId })]);
    }

    case "thread.settings.update": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      // Choosing a connector is only possible while nothing has run on one: a
      // session belongs to its harness and cannot be carried to another. The
      // same answer as the picker's, so a disabled picker is never a lie.
      //
      // Once locked, what counts is the instance the thread actually runs on —
      // the bound session's, which routing may have picked over the stored
      // choice — and naming that one again is no change at all. A thread with
      // no session and no stored choice (created before threads could choose,
      // or from a path that passes no settings) runs wherever the default rule
      // sends it, so there is nothing recorded to change either: the patch's
      // other fields apply and the instance stays out of the event.
      const locked = threadLocksConnector(thread);
      const current = locked
        ? (thread.session?.connectorInstanceId ?? thread.settings.connectorInstanceId)
        : thread.settings.connectorInstanceId;
      const named = command.connectorInstanceId;
      const differs = named !== undefined && named !== current;
      if (differs && locked && current !== undefined) {
        return rejected(
          `thread ${command.threadId} has already run on a connector — start a new thread to use another connector`,
        );
      }
      const connectorChange = differs && !locked;
      return accepted([
        emit("thread.settings.updated", {
          ...(command.model === undefined ? {} : { model: command.model }),
          ...(command.effort === undefined ? {} : { effort: command.effort }),
          ...(command.runtimeMode === undefined ? {} : { runtimeMode: command.runtimeMode }),
          ...(command.interactionMode === undefined
            ? {}
            : { interactionMode: command.interactionMode }),
          ...(connectorChange ? { connectorInstanceId: command.connectorInstanceId } : {}),
        }),
      ]);
    }

    case "thread.approval.respond": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      const request = thread.approvals.find((pending) => pending.requestId === command.requestId);
      if (request === undefined) {
        return rejected(`no pending approval ${command.requestId}`);
      }
      const rule: NewPermissionRule | undefined =
        command.pattern === undefined
          ? undefined
          : command.decision === "allow-always"
            ? {
                scope: "project",
                projectId: thread.projectId,
                pattern: command.pattern,
                decision: "allow",
              }
            : command.decision === "allow-session"
              ? {
                  scope: "session",
                  threadId: command.threadId,
                  pattern: command.pattern,
                  decision: "allow",
                }
              : undefined;
      return accepted(
        [
          emit("thread.approval.resolved", {
            requestId: command.requestId,
            decision: command.decision,
            ...(command.pattern === undefined ? {} : { pattern: command.pattern }),
          }),
        ],
        rule,
      );
    }

    case "thread.userInput.respond": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      const pending = thread.userInputs.find((input) => input.requestId === command.requestId);
      if (pending === undefined) {
        return rejected(`no pending user input ${command.requestId}`);
      }
      return accepted([
        emit("thread.userInput.resolved", {
          requestId: command.requestId,
          answers: command.answers,
        }),
      ]);
    }

    case "thread.plan.respond": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.pendingPlan === null || thread.pendingPlan.turnId !== command.turnId) {
        return rejected(`no pending plan for turn ${command.turnId}`);
      }
      return accepted([
        emit("thread.plan.responded", {
          turnId: command.turnId,
          action: command.action,
          ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
          // The fold clears pendingPlan on this very event, so the path the
          // accept turn names travels on it rather than in a reactor's memory.
          ...(thread.pendingPlan.planPath === undefined
            ? {}
            : { planPath: thread.pendingPlan.planPath }),
        }),
      ]);
    }

    case "thread.queue.remove": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      // A queued message the next turn already consumed is gone, not an
      // error the user can act on — but saying so beats a silent no-op.
      if (!thread.queue.some((message) => message.queuedMessageId === command.queuedMessageId)) {
        return rejected(`no queued message ${command.queuedMessageId}`);
      }
      return accepted([
        emit("thread.message.dequeued", { queuedMessageId: command.queuedMessageId }),
      ]);
    }

    case "thread.queue.reorder": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      const from = thread.queue.findIndex(
        (message) => message.queuedMessageId === command.queuedMessageId,
      );
      if (from === -1) {
        return rejected(`no queued message ${command.queuedMessageId}`);
      }
      if (command.toIndex >= thread.queue.length) {
        return rejected(`the queue has no position ${command.toIndex}`);
      }
      // A move to where the message already is changes nothing. Accepting it
      // without an event keeps the log free of no-op reorders.
      if (from === command.toIndex) {
        return accepted([]);
      }
      const order = thread.queue.map((message) => message.queuedMessageId);
      order.splice(from, 1);
      order.splice(command.toIndex, 0, command.queuedMessageId);
      return accepted([emit("thread.queue.reordered", { order })]);
    }

    case "thread.checkpoint.restore": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      // Restore is side-effectful git work — `git restore` + `git clean`
      // would clobber files a running turn is mid-write on.
      if (thread.currentTurn !== null) {
        return rejected(`thread ${command.threadId} has a running turn`);
      }
      if (thread.restoring) {
        return rejected(`thread ${command.threadId} is already restoring a checkpoint`);
      }
      // Two restores in one worktree race each other's `git restore` and
      // `git clean -fd` (and each other's index.lock).
      if (ctx.restoreInFlight(thread)) {
        return rejected(
          `another thread in project ${thread.projectId} is already restoring a checkpoint`,
        );
      }
      const checkpoint = thread.checkpoints.find(
        (entry) => entry.checkpointId === command.checkpointId,
      );
      if (checkpoint === undefined) {
        return rejected(`no checkpoint ${command.checkpointId}`);
      }
      // The event is the durable work order and nothing more: the
      // CheckpointReactor does the git work off it and records the outcome as
      // `thread.checkpoint.restored` or `thread.checkpoint.restore.failed`. A
      // crash between receipt and restore is replayed at the next boot.
      return accepted([emit("thread.checkpoint.restore.requested", { checkpoint })]);
    }
  }
};
