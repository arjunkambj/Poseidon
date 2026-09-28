/**
 * The checkpoint seam the git implementation fills.
 *
 * `CheckpointHook` is the service `apps/server/src/git` implements: `capture`
 * turns a finished turn into a hidden-ref checkpoint summary (or `null` when
 * nothing changed), `restore` checks one out. The default implementation is an
 * explicit no-op, so the orchestration stack runs without git.
 *
 * `CheckpointReactor` wires it to the log: `turn.completed` → capture →
 * `thread.checkpoint.created`; a `thread.checkpoint.restore.requested` work
 * order → the git work → `thread.checkpoint.restored` or
 * `thread.checkpoint.restore.failed`, never before. A work order that carries
 * an edited message (`resend`) starts a turn with it once `restored` is in the
 * log, and only then. Work orders with no outcome recorded are replayed at
 * layer build, so a crash between the accepted command and the git work cannot
 * drop the restore, or the message riding on it; and a thread's latest
 * `restored` order whose send never ran is sent then too, so neither can a
 * crash between the outcome and the send. Thread deletion
 * and project removal each prune the hidden refs under the thread's prefix —
 * the project case enumerates the thread streams, because the removal's
 * transaction has already deleted the read-model rows.
 */

import { makeEventId } from "@poseidon/contracts/ids";
import type { CommandId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import type {
  CheckpointRestore,
  CheckpointSummary,
  OrchestrationEvent,
  TurnResend,
} from "@poseidon/contracts/orchestration";
import { latestTurnId } from "@poseidon/contracts/orchestration";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { PlannedEvent } from "../persistence/EventStore";
import { EventStore } from "../persistence/EventStore";
import { OrchestrationEngine, type EngineError } from "./Engine";
import { foldProject, foldThread, type ThreadDoc } from "./state";
import { threadWorkspaceRoot } from "./workspaceRoot";

export class CheckpointHookError extends Data.TaggedError("CheckpointHookError")<{
  readonly message: string;
}> {}

export interface CheckpointCaptureInput {
  readonly thread: ThreadDoc;
  readonly turnId: TurnId;
  readonly workspaceRoot: string;
}

export interface CheckpointRestoreInput {
  readonly thread: ThreadDoc;
  readonly checkpoint: CheckpointSummary;
  readonly workspaceRoot: string;
}

export interface CheckpointPruneInput {
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
}

export class CheckpointHook extends Context.Service<
  CheckpointHook,
  {
    readonly capture: (
      input: CheckpointCaptureInput,
    ) => Effect.Effect<CheckpointSummary | null, CheckpointHookError>;
    readonly restore: (input: CheckpointRestoreInput) => Effect.Effect<void, CheckpointHookError>;
    readonly prune: (input: CheckpointPruneInput) => Effect.Effect<void, CheckpointHookError>;
  }
>()("server/orchestration/CheckpointHook") {
  /** No git integration yet — capture reports nothing to record. */
  static readonly noop: Layer.Layer<CheckpointHook> = Layer.succeed(
    CheckpointHook,
    CheckpointHook.of({
      capture: () => Effect.succeed(null),
      prune: () => Effect.void,
      restore: () =>
        Effect.fail(
          new CheckpointHookError({
            message: "checkpoints are not available in this build",
          }),
        ),
    }),
  );
}

/** A `thread.checkpoint.restore.requested` work order's payload. */
const orderOf = (entry: OrchestrationEvent) =>
  entry.payload as { readonly checkpoint: CheckpointSummary; readonly resend?: TurnResend };

export const CheckpointReactor: Layer.Layer<
  never,
  never,
  OrchestrationEngine | CheckpointHook | EventStore
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const hook = yield* CheckpointHook;
    const store = yield* EventStore;

    const recordError = (threadId: ThreadId, message: string, causedBy: string) =>
      engine.appendThreadEvents(threadId, [
        {
          eventId: makeEventId(),
          streamKind: "thread",
          streamId: threadId,
          occurredAt: new Date().toISOString(),
          causationEventId: causedBy as never,
          correlationId: causedBy,
          actor: "system",
          type: "thread.error",
          payload: { message, fatal: false },
        } satisfies PlannedEvent,
      ]);

    /**
     * Capture and restore run in the thread's own root: HEAD and the index are
     * per worktree, so a worktree thread's snapshot has to be taken there.
     * Prune stays on the project root (see `workspaceRoot.ts`).
     */
    const workspaceRootFor = (doc: ThreadDoc) =>
      engine
        .projectDoc(doc.projectId)
        .pipe(
          Effect.map((project) => (project === null ? null : threadWorkspaceRoot(doc, project))),
        );

    /**
     * The outcome write is what takes a thread out of `restoring`, and a
     * thread that never leaves it can neither start a turn nor restore again.
     * A transient `SqlError` here must not be what pins it, so the append is
     * retried a few times before the caller's handler gives up; a run that
     * never records an outcome is picked up again by the replay at next boot.
     */
    const settle = (
      threadId: ThreadId,
      type: "thread.checkpoint.restored" | "thread.checkpoint.restore.failed",
      payload: OrchestrationEvent["payload"],
      causedBy: string,
    ) =>
      engine
        .appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: new Date().toISOString(),
            causationEventId: causedBy as never,
            correlationId: causedBy,
            actor: "system",
            type,
            payload,
          } as PlannedEvent,
        ])
        .pipe(
          Effect.retry(
            Schedule.recurs(3).pipe(Schedule.addDelay(() => Effect.succeed("50 millis" as const))),
          ),
        );

    /**
     * One restore at a time, whatever fiber asks for it. The decider already
     * excludes a second restore in the same project, but the boot replay runs
     * on its own fiber beside the live subscription — this is what keeps two
     * `git restore`/`git clean -fd` pairs out of one repository even so.
     */
    const restoreMutex = yield* Semaphore.make(1);

    /**
     * Edit and resend: the edited message goes out as an ordinary turn, once
     * the worktree is back where it was before the original. Called only
     * after `restored` is appended, so a failed restore sends nothing; and
     * the run that appended it or, when the process stopped in between, from
     * the next boot's replay (`resendIfUnsent`). The command's id is the work
     * order's event id, so the engine's receipt says whether it went out and
     * a second dispatch returns that receipt instead of sending twice. A
     * refusal lands on the thread as an error line rather than vanishing,
     * since the composer has let go of the text by then.
     */
    const sendResend = (threadId: ThreadId, resend: TurnResend, causedBy: string) =>
      engine
        .dispatch({
          commandId: causedBy as CommandId,
          createdAt: new Date().toISOString(),
          type: "thread.turn.start",
          threadId,
          text: resend.text,
          attachments: resend.attachments,
          mentions: resend.mentions,
          ...(resend.references === undefined ? {} : { references: resend.references }),
          queued: false,
        })
        .pipe(
          Effect.flatMap((receipt) =>
            receipt.status === "accepted"
              ? Effect.void
              : recordError(
                  threadId,
                  `the edited message was not sent: ${receipt.reason ?? "rejected"}`,
                  causedBy,
                ).pipe(Effect.asVoid),
          ),
          Effect.catch((error) => Effect.logWarning("edited message send failed", error)),
        );

    /**
     * The git work for one accepted restore, and the durable record of how it
     * went. `restored` is written only after git succeeded — a client that
     * folded the work order sees the thread leave `restoring` either way.
     */
    const restoreOnce = (
      threadId: ThreadId,
      checkpoint: CheckpointSummary,
      causedBy: string,
      resend: TurnResend | undefined,
    ): Effect.Effect<void, EngineError> =>
      Effect.gen(function* () {
        const doc = yield* engine.threadDoc(threadId);
        if (doc === null || doc.deleted) {
          return;
        }
        const workspaceRoot = yield* workspaceRootFor(doc);
        if (workspaceRoot === null) {
          yield* settle(
            threadId,
            "thread.checkpoint.restore.failed",
            { checkpointId: checkpoint.checkpointId, message: "the project no longer exists" },
            causedBy,
          );
          return;
        }
        const failure = yield* hook.restore({ thread: doc, checkpoint, workspaceRoot }).pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
        if (failure !== null) {
          yield* settle(
            threadId,
            "thread.checkpoint.restore.failed",
            { checkpointId: checkpoint.checkpointId, message: failure },
            causedBy,
          );
          return;
        }
        yield* settle(threadId, "thread.checkpoint.restored", { checkpoint }, causedBy);
        if (resend !== undefined) {
          yield* sendResend(threadId, resend, causedBy);
        }
      });

    /**
     * The send of a work order the last process restored but may have stopped
     * before sending. Skipped when its receipt exists (it went out, or was
     * refused and said so), and when the thread has moved on since: a turn
     * after the restore, one running, or another restore.
     */
    const resendIfUnsent = (threadId: ThreadId, order: OrchestrationEvent, resend: TurnResend) =>
      Effect.gen(function* () {
        if ((yield* store.receipt(order.eventId as unknown as CommandId)) !== null) {
          return;
        }
        const doc = yield* engine.threadDoc(threadId);
        if (doc === null || doc.deleted || doc.currentTurn !== null || doc.restoring) {
          return;
        }
        const last = ((doc.restores as ReadonlyArray<CheckpointRestore> | undefined) ?? []).at(-1);
        if (last === undefined || latestTurnId(doc.items) !== last.afterTurnId) {
          return;
        }
        yield* sendResend(threadId, resend, order.eventId);
      });

    /** Work orders this process has already acted on — see `runRestore`. */
    const handled = yield* Ref.make<ReadonlySet<string>>(new Set());

    /**
     * One run per work order, whichever path reaches it first. The replay list
     * is read before the live loop starts, so the two cannot claim the same
     * order — this is the backstop that makes that true by construction rather
     * than by the ordering of two fibers.
     */
    const runRestore = (
      threadId: ThreadId,
      checkpoint: CheckpointSummary,
      causedBy: string,
      resend: TurnResend | undefined,
    ): Effect.Effect<void, EngineError> =>
      restoreMutex.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(handled)).has(causedBy)) {
            return;
          }
          yield* Ref.update(handled, (seen) => new Set(seen).add(causedBy));
          yield* restoreOnce(threadId, checkpoint, causedBy, resend);
        }),
      );

    // A finished turn is a checkpoint point.
    const eventMailbox = yield* engine.subscribeEvents;

    /**
     * A restore accepted before the last shutdown: the work order is in the
     * log with no `restored`/`restore.failed` after it, so nothing has touched
     * the worktree yet.
     *
     * The list is read here, during the layer build, and only the git work is
     * forked: a work order accepted after this read cannot be in it, so the
     * live subscription below owns that one alone. Reading it on the forked
     * fiber instead would let an order published in the meantime be both
     * queued in the mailbox and still outcome-less in the log — two `git
     * restore`/`git clean -fd` runs and two outcomes for one order.
     */
    const pendingRestores = Effect.gen(function* () {
      // Only the four types this fold looks at, off the `(type, sequence)`
      // index. It used to read and schema-decode every thread event ever
      // written, here, inside the layer build — before `boot` writes its
      // handshake, and the desktop supervisor SIGKILLs a child that has not
      // handshaken in fifteen seconds and gives up after five of those. A big
      // enough log made a perfectly intact install unstartable for good.
      const events = yield* store.threadEventsOfTypes([
        "thread.checkpoint.restore.requested",
        "thread.checkpoint.restored",
        "thread.checkpoint.restore.failed",
        "thread.deleted",
      ]);
      const pending = new Map<ThreadId, OrchestrationEvent>();
      // Each thread's latest order, when it was restored and carries a message.
      const restored = new Map<ThreadId, OrchestrationEvent>();
      for (const entry of events) {
        const threadId = entry.streamId as ThreadId;
        if (entry.type === "thread.checkpoint.restore.requested") {
          pending.set(threadId, entry);
          restored.delete(threadId);
        } else if (entry.type === "thread.checkpoint.restored") {
          const order = pending.get(threadId);
          pending.delete(threadId);
          if (order !== undefined && orderOf(order).resend !== undefined) {
            restored.set(threadId, order);
          }
        } else if (
          entry.type === "thread.checkpoint.restore.failed" ||
          entry.type === "thread.deleted"
        ) {
          pending.delete(threadId);
          restored.delete(threadId);
        }
      }
      return { pending: [...pending.values()], restored: [...restored.values()] };
    });

    const { pending, restored } = yield* pendingRestores.pipe(
      // `catchCause`, not `catch`: this runs inside the layer build, so a
      // defect from the read — an undecodable row used to throw one — did not
      // fail the reactor, it failed `Layer.build(app)`, and the server never
      // reached its handshake.
      Effect.catchCause((cause) =>
        Effect.logWarning("checkpoint restore replay could not read the log", cause).pipe(
          Effect.as({
            pending: [] as ReadonlyArray<OrchestrationEvent>,
            restored: [] as ReadonlyArray<OrchestrationEvent>,
          }),
        ),
      ),
    );
    // Only the git work is forked: it must not hold up the layer build, and
    // each thread stays `restoring` (and so unusable for turns) until its own
    // replay finishes.
    yield* Effect.forEach(pending, (entry) => {
      const order = orderOf(entry);
      return runRestore(entry.streamId as ThreadId, order.checkpoint, entry.eventId, order.resend);
    }).pipe(
      Effect.andThen(
        Effect.forEach(restored, (entry) => {
          const resend = orderOf(entry).resend;
          return resend === undefined
            ? Effect.void
            : resendIfUnsent(entry.streamId as ThreadId, entry, resend);
        }),
      ),
      Effect.catch((error) => Effect.logWarning("checkpoint restore replay failed", error)),
      Effect.forkScoped,
    );
    yield* Stream.runForEach(Stream.fromSubscription(eventMailbox), (event) =>
      Effect.gen(function* () {
        // Project removed → every thread's checkpoint prefix goes. The
        // removal's transaction already deleted the thread rows, so the
        // enumeration reads the event log, not the read model.
        if (event.streamKind === "project" && event.type === "project.removed") {
          const projectId = event.payload.projectId;
          const projectDoc = foldProject(yield* store.loadStream("project", projectId));
          if (projectDoc === null) {
            return;
          }
          const threadEvents = yield* store.threadEventsAfter(0);
          const threadIds = new Set<ThreadId>();
          for (const entry of threadEvents) {
            if (entry.type === "thread.created" && entry.payload.projectId === projectId) {
              threadIds.add(entry.streamId as ThreadId);
            }
          }
          for (const threadId of threadIds) {
            yield* hook
              .prune({ threadId, workspaceRoot: projectDoc.workspaceRoot })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`checkpoint prune failed: ${error.message}`),
                ),
              );
          }
          return;
        }
        if (event.streamKind !== "thread") {
          return;
        }
        // Thread deleted → drop every hidden checkpoint ref under its prefix.
        // The delete's transaction removed the read-model row before this
        // event was published, so the thread's project — and with it the
        // worktree the refs live in — comes from the log, not `threadDoc`.
        if (event.type === "thread.deleted") {
          const threadId = event.streamId as ThreadId;
          const doc = foldThread(yield* store.loadStream("thread", threadId));
          if (doc === null) {
            return;
          }
          const projectDoc = foldProject(yield* store.loadStream("project", doc.projectId));
          if (projectDoc === null) {
            return;
          }
          const workspaceRoot = projectDoc.workspaceRoot;
          return yield* hook
            .prune({ threadId, workspaceRoot })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(`checkpoint prune failed: ${error.message}`),
              ),
            );
        }
        // The accepted restore command records the work order; the reactor
        // runs off the log, not the transient command publication, so a crash
        // before this point is replayed at the next boot instead of lost.
        if (event.type === "thread.checkpoint.restore.requested") {
          return yield* runRestore(
            event.streamId as ThreadId,
            event.payload.checkpoint,
            event.eventId,
            event.payload.resend,
          );
        }
        if (event.type !== "thread.turn.completed") {
          return;
        }
        const threadId = event.streamId as ThreadId;
        const doc = yield* engine.threadDoc(threadId);
        if (doc === null || doc.deleted) {
          return;
        }
        const workspaceRoot = yield* workspaceRootFor(doc);
        if (workspaceRoot === null) {
          return;
        }
        const summary = yield* hook
          .capture({
            thread: doc,
            turnId: event.payload.turnId,
            workspaceRoot,
          })
          .pipe(
            Effect.catch((error) =>
              recordError(
                threadId,
                `checkpoint capture failed: ${error.message}`,
                event.eventId,
              ).pipe(Effect.as(null)),
            ),
          );
        if (summary === null) {
          return;
        }
        yield* engine.appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: new Date().toISOString(),
            causationEventId: event.eventId,
            correlationId: event.eventId,
            actor: "system",
            type: "thread.checkpoint.created",
            payload: { checkpoint: summary },
          } satisfies PlannedEvent,
        ]);
      }).pipe(
        Effect.catch((error) => Effect.logWarning("checkpoint capture reactor failed", error)),
      ),
    ).pipe(Effect.forkScoped);
  }),
);
