/**
 * The connector-facing reactor: turns, interrupts, responses, queue drain.
 *
 * Everything here is an event reaction, never a dispatch input — the decider
 * already decided; this fiber performs the side effect the event calls for:
 *
 * - `turn.requested` → ensure the session, `handle.send(turnId, turn)`.
 * - `turn.steered` → `handle.steer(turnId, turn)` into the running turn, then
 *   the user's row; a message that cannot be delivered falls back to the
 *   queue, never lost.
 * - `turn.interrupted` → `handle.interrupt(turnId)`; the turn stays in flight
 *   until the connector settles it, and this fiber settles it itself when
 *   there is no live session left to do so.
 * - `task.stopRequested` → `handle.stopTask(itemId)`; the harness settles the
 *   task row, and the turn goes on.
 * - `approval.resolved` / `userInput.resolved` / `plan.responded` → the
 *   matching `respond*` on the live handle, plus the plan follow-up commands.
 * - `settings.updated` → `handle.updateSettings` so mode/model changes reach
 *   the running session (without `connectorInstanceId`, which is routing).
 * - `turn.completed` → drain the queue: dequeue the head, dispatch it as a new
 *   turn.
 * - `project.removed` → dispatch `thread.delete` for every thread under it.
 * - `thread.archived` / `thread.deleted` → close the session.
 *
 * A failing side effect records `thread.error` (and a synthetic
 * `turn.completed` when a turn was mid-flight) instead of leaving the thread
 * wedged in `running`.
 */

import { makeCommandId, makeEventId, makeItemId } from "@poseidon/contracts/ids";
import type { ItemId, ProjectId, RequestId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import type { ApprovalDecision } from "@poseidon/contracts/enums";
import type {
  Attachment,
  Mention,
  OrchestrationEvent,
  PlanResponseAction,
  QueuedMessage,
  ThreadSettingsPatch,
  TurnReference,
} from "@poseidon/contracts/orchestration";
import type { UserQuestionAnswer } from "@poseidon/contracts/runtime";
import type { TurnInput } from "@poseidon/connector-sdk/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { PlannedEvent } from "../persistence/EventStore";
import { OrchestrationEngine } from "./Engine";
import { withForkContext } from "./forkSeed";
import { SessionManager } from "./SessionManager";
import type { ThreadDoc } from "./state";
import { userMessageItem } from "./userMessageItem";
import { threadWorkspaceRoot } from "./workspaceRoot";

const systemEvent = <Type extends OrchestrationEvent["type"]>(
  threadId: ThreadId,
  type: Type,
  payload: Extract<OrchestrationEvent, { type: Type }>["payload"],
  occurredAt: string,
  causedBy: string,
): PlannedEvent =>
  ({
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    occurredAt,
    causationEventId: causedBy as PlannedEvent["causationEventId"],
    correlationId: causedBy,
    actor: "system",
    type,
    payload,
  }) as PlannedEvent;

/** What a failure with nothing to say is called on the timeline. */
const GENERIC_FAILURE = "the connector failed";

/**
 * A description that is never the empty string.
 *
 * Four of the five errors this reactor can see from a turn — `NoConnector`,
 * `ConnectorNotFound`, `SessionClosed`, `TurnInProgress` — are `Data.TaggedError`s
 * with no `message` field, and `Error.message` on those is `""`. Writing that
 * onto `thread.error` produced a row `OrchestrationEvent` cannot decode, which
 * took the thread down and then, through the checkpoint reactor's boot replay,
 * the whole server. The tag is what the user can act on anyway: "removed
 * connector" reads very differently from "session closed".
 */
const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.trim() !== "") {
    return message;
  }
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as { readonly _tag: unknown })._tag)
      : "";
  return tag === "" ? GENERIC_FAILURE : `${GENERIC_FAILURE}: ${tag}`;
};

export const ProviderCommandReactor = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const sessions = yield* SessionManager;

    const dispatchSettings = (threadId: ThreadId, patch: ThreadSettingsPatch) =>
      engine.dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.settings.update",
        threadId,
        ...patch,
      });

    const dispatchTurn = (threadId: ThreadId, input: TurnInput, queued = false) =>
      engine.dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.turn.start",
        threadId,
        text: input.text,
        attachments: input.attachments,
        mentions: input.mentions,
        ...(input.references === undefined ? {} : { references: input.references }),
        queued,
      });

    /** Records a hard failure and, mid-turn, settles the turn. */
    const failThread = (threadId: ThreadId, doc: ThreadDoc, message: string, causedBy: string) =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const planned: Array<PlannedEvent> = [
          systemEvent(
            threadId,
            "thread.error",
            // `thread.error.message` is a NonEmptyString, so an empty one is a
            // row the log can hold but not read back. Clamped here rather than
            // only at the call site: every future caller gets the same floor.
            { message: message.trim() === "" ? GENERIC_FAILURE : message, fatal: true },
            now,
            causedBy,
          ),
        ];
        if (doc.currentTurn !== null) {
          planned.push(
            systemEvent(
              threadId,
              "thread.turn.completed",
              { turnId: doc.currentTurn.turnId, stopReason: "error" },
              now,
              causedBy,
            ),
          );
        }
        yield* engine.appendThreadEvents(threadId, planned);
      });

    /**
     * Delivers a steered message into the turn it was meant for. The decider
     * steers only a thread whose harness said it can, but the message can
     * still miss: the session went away, or the turn ended between the
     * decision and this call. Then it goes back through the queue instead —
     * `queued: true` starts a turn when none is running and queues behind the
     * one that is — and a refusal of that too puts it on the queue directly,
     * as the drain does, so the user never loses what they typed.
     *
     * The user's row is written here, only once the message has reached the
     * turn: a miss leaves it to the turn the queue starts, so the message
     * never shows twice or sits in a turn that never saw it.
     */
    const steerOrQueue = (threadId: ThreadId, turnId: TurnId, input: TurnInput, causedBy: string) =>
      Effect.gen(function* () {
        const handle = yield* sessions.handleFor(threadId);
        const delivered = yield* handle === null
          ? Effect.succeed(false)
          : handle.steer(turnId, input).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning("steer failed", error).pipe(Effect.as(false)),
              ),
            );
        if (delivered) {
          yield* engine.appendThreadEvents(threadId, [
            systemEvent(
              threadId,
              "thread.item.upserted",
              { turnId, item: userMessageItem(makeItemId(), turnId, input) },
              new Date().toISOString(),
              causedBy,
            ),
          ]);
          return;
        }
        const receipt = yield* dispatchTurn(threadId, input, true);
        if (receipt.status === "accepted") {
          return;
        }
        const now = new Date().toISOString();
        yield* engine.appendThreadEvents(threadId, [
          systemEvent(
            threadId,
            "thread.message.queued",
            {
              message: {
                queuedMessageId: makeItemId(),
                text: input.text,
                attachments: input.attachments,
                mentions: input.mentions,
                ...(input.references === undefined || input.references.length === 0
                  ? {}
                  : { references: input.references }),
                queuedAt: now,
              },
            },
            now,
            causedBy,
          ),
        ]);
        yield* Effect.logWarning(
          `a steer for ${threadId} was queued: ${receipt.reason ?? "rejected"}`,
        );
      });

    const dispatchDelete = (threadId: ThreadId) =>
      engine.dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.delete",
        threadId,
      });

    const react = (event: OrchestrationEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        // A removed project takes its threads with it, one `thread.delete` at
        // a time: that is the only path that closes their sessions and prunes
        // their checkpoints. Deleting the rows wholesale would leave connector
        // processes running against a project that no longer exists.
        if (event.streamKind === "project" && event.type === "project.removed") {
          const projectId = (event.payload as Record<string, unknown>).projectId as ProjectId;
          const docs = yield* engine.threadDocs;
          for (const doc of docs) {
            if (doc.projectId === projectId && !doc.deleted) {
              yield* dispatchDelete(doc.threadId);
            }
          }
          return;
        }
        if (event.streamKind !== "thread") {
          return;
        }
        const threadId = event.streamId as ThreadId;
        const payload = event.payload as Record<string, unknown>;

        switch (event.type) {
          case "thread.turn.requested": {
            const doc = yield* engine.threadDoc(threadId);
            if (doc === null || doc.deleted) {
              return;
            }
            const project = yield* engine.projectDoc(doc.projectId);
            if (project === null) {
              return;
            }
            const turnId = payload.turnId as TurnId;
            yield* sessions.ensure(doc, threadWorkspaceRoot(doc, project)).pipe(
              Effect.flatMap((handle) =>
                Effect.flatMap(sessions.forkedNatively(threadId), (native) =>
                  // A fork's first turn carries its source's transcript,
                  // unless the harness forked the source's session itself.
                  handle.send(
                    turnId,
                    withForkContext(
                      doc,
                      turnId,
                      {
                        text: payload.text as string,
                        attachments: (payload.attachments ?? []) as ReadonlyArray<Attachment>,
                        mentions: (payload.mentions ?? []) as ReadonlyArray<Mention>,
                        references: (payload.references ?? []) as ReadonlyArray<TurnReference>,
                      },
                      native,
                    ),
                  ),
                ),
              ),
              Effect.catch((error) =>
                failThread(threadId, doc, describeError(error), event.eventId),
              ),
            );
            return;
          }

          case "thread.turn.steered": {
            yield* steerOrQueue(
              threadId,
              payload.turnId as TurnId,
              {
                text: payload.text as string,
                attachments: (payload.attachments ?? []) as ReadonlyArray<Attachment>,
                mentions: (payload.mentions ?? []) as ReadonlyArray<Mention>,
                references: (payload.references ?? []) as ReadonlyArray<TurnReference>,
              },
              event.eventId,
            );
            return;
          }

          case "thread.session.bound": {
            // A session that binds while a turn is in-flight means we resumed
            // after a loss — re-send the turn (the turn-scoped handle dedupes
            // a turn it already has, so the fresh-session path is free).
            const doc = yield* engine.threadDoc(threadId);
            const handle = yield* sessions.handleFor(threadId);
            if (doc !== null && handle !== null && doc.currentTurn !== null) {
              const { turnId, input } = doc.currentTurn;
              const native = yield* sessions.forkedNatively(threadId);
              yield* handle
                .send(turnId, withForkContext(doc, turnId, input, native))
                .pipe(Effect.catch((error) => Effect.logWarning("resume resend failed", error)));
            }
            return;
          }

          case "thread.turn.interrupted": {
            const turnId = payload.turnId as TurnId;
            const handle = yield* sessions.handleFor(threadId);
            // The turn stays in flight until something settles it. Normally
            // that is the connector's own `turn.completed`, which the handle
            // emits once it has stopped; if there is no live session, or the
            // interrupt itself fails, nothing else ever will — so settle it
            // here rather than leave the thread stuck in `running`.
            const settled = yield* handle === null
              ? Effect.succeed(false)
              : handle.interrupt(turnId).pipe(
                  Effect.as(true),
                  Effect.catch((error) =>
                    Effect.logWarning("interrupt failed", error).pipe(Effect.as(false)),
                  ),
                );
            if (!settled) {
              yield* engine
                .appendThreadEvents(threadId, [
                  systemEvent(
                    threadId,
                    "thread.turn.completed",
                    { turnId, stopReason: "interrupted" },
                    new Date().toISOString(),
                    event.eventId,
                  ),
                ])
                .pipe(Effect.catch((error) => Effect.logWarning("interrupt settle failed", error)));
            }
            return;
          }

          case "thread.task.stopRequested": {
            const handle = yield* sessions.handleFor(threadId);
            if (handle?.stopTask !== undefined) {
              yield* handle
                .stopTask(payload.itemId as ItemId)
                .pipe(Effect.catch((error) => Effect.logWarning("task stop failed", error)));
            }
            return;
          }

          case "thread.approval.resolved": {
            const handle = yield* sessions.handleFor(threadId);
            if (handle !== null) {
              yield* handle
                .respondToRequest(
                  payload.requestId as RequestId,
                  payload.decision as ApprovalDecision,
                )
                .pipe(Effect.catch((error) => Effect.logWarning("respond failed", error)));
            }
            return;
          }

          case "thread.userInput.resolved": {
            const handle = yield* sessions.handleFor(threadId);
            if (handle !== null) {
              yield* handle
                .respondToUserInput(
                  payload.requestId as RequestId,
                  payload.answers as ReadonlyArray<UserQuestionAnswer>,
                )
                .pipe(Effect.catch((error) => Effect.logWarning("respond failed", error)));
            }
            return;
          }

          case "thread.plan.responded": {
            const handle = yield* sessions.handleFor(threadId);
            const action = payload.action as PlanResponseAction;
            if (handle !== null) {
              yield* handle
                .respondToPlan(
                  payload.turnId as TurnId,
                  action,
                  payload.feedback as string | undefined,
                )
                .pipe(Effect.catch((error) => Effect.logWarning("plan respond failed", error)));
            }
            // What each plan action does next.
            const doc = yield* engine.threadDoc(threadId);
            if (doc === null || doc.deleted || doc.status === "archived") {
              return;
            }
            // The accept turn names the plan file it approved. The
            // decider copies it onto this event out of the pending plan it is
            // clearing, so it survives a restart between propose and accept.
            const planPath = typeof payload.planPath === "string" ? payload.planPath : undefined;
            if (action === "accept" || action === "accept-auto") {
              // Accepting leaves plan mode: without the reset the next turn
              // produces another plan instead of implementing this one.
              yield* dispatchSettings(
                threadId,
                action === "accept-auto"
                  ? { interactionMode: "default", runtimeMode: "auto-accept-edits" }
                  : { interactionMode: "default" },
              );
              yield* dispatchTurn(threadId, {
                text:
                  planPath === undefined
                    ? "Implement the approved plan."
                    : `Implement the approved plan at ${planPath}`,
                attachments: [],
                mentions: [],
              });
            } else if (action === "revise") {
              yield* dispatchSettings(threadId, { interactionMode: "plan" });
              yield* dispatchTurn(threadId, {
                text: (payload.feedback as string | undefined) ?? "Revise the plan",
                attachments: [],
                mentions: [],
              });
            } else if (action === "handoff") {
              // The plan is implemented in a thread of its own. This one only
              // leaves plan mode, so its next message is not another plan.
              yield* dispatchSettings(threadId, { interactionMode: "default" });
            }
            return;
          }

          case "thread.settings.updated": {
            const handle = yield* sessions.handleFor(threadId);
            if (handle !== null) {
              // The instance is routing, not something a session can act on —
              // and the decider never lets it change under a live one anyway.
              const { connectorInstanceId: _routing, ...patch } = payload as ThreadSettingsPatch;
              yield* handle
                .updateSettings(patch)
                .pipe(Effect.catch((error) => Effect.logWarning("updateSettings failed", error)));
            }
            return;
          }

          case "thread.turn.completed": {
            // Choosing the message inside the append transaction is what makes
            // this safe against `thread.queue.remove`: reading the queue out
            // here and appending afterwards let a removal decided in between be
            // accepted — the row left the strip and the message was sent anyway.
            const taken: Array<QueuedMessage> = [];
            // Dequeue first, then dispatch — the request event lands after the
            // queue mutation so a projector replaying the stream sees the same order.
            //
            // A turn still in flight means this completion is not the one that
            // freed the connector — a late settlement of a turn an archive
            // closed, after an unarchive let a newer one start. That turn's
            // own completion drains the queue instead.
            yield* engine.appendThreadEvents(threadId, (doc) => {
              const next =
                doc.status === "archived" || doc.currentTurn !== null ? undefined : doc.queue[0];
              if (next === undefined) {
                return [];
              }
              taken.push(next);
              return [
                systemEvent(
                  threadId,
                  "thread.message.dequeued",
                  { queuedMessageId: next.queuedMessageId },
                  new Date().toISOString(),
                  event.eventId,
                ),
              ];
            });
            const next = taken[0];
            if (next === undefined) {
              return;
            }
            // The queued message carries the composer's whole input —
            // redispatching just the text would silently drop its
            // attachments, mentions and references.
            //
            // `queued: true`, and the receipt is read. The dequeue above has
            // already committed, so anything that makes the decider refuse this
            // command in the gap — a sibling thread starting a checkpoint
            // restore, the user archiving the thread, a send of their own that
            // wins the write mutex — destroyed the message: out of the strip,
            // never sent, nowhere to recover the text from. Queueing instead of
            // refusing covers the "a turn is already running" case outright,
            // and a refusal for any other reason puts the message back where
            // the user can still see and resend it.
            const receipt = yield* dispatchTurn(threadId, next, true);
            if (receipt.status === "rejected") {
              yield* engine.appendThreadEvents(threadId, [
                systemEvent(
                  threadId,
                  "thread.message.queued",
                  { message: next },
                  new Date().toISOString(),
                  event.eventId,
                ),
              ]);
              yield* Effect.logWarning(
                `queue drain re-queued a message for ${threadId}: ${receipt.reason ?? "rejected"}`,
              );
            }
            return;
          }

          // An archived thread has no UI attached any more; leaving its
          // connector running keeps a process (and its token budget) alive for
          // nothing, and the supervisor would resume it after a restart.
          case "thread.archived":
          case "thread.deleted": {
            yield* sessions.close(threadId);
            return;
          }
        }
      }).pipe(
        // `catchCause`, not `catch`: a defect here — a schema decode that threw
        // deep inside a read, say — would otherwise kill the loop fiber and the
        // reactor would stop reacting to everything, silently.
        Effect.catchCause((cause) => Effect.logWarning("provider reactor dropped an event", cause)),
      );

    // Eager subscribe: the mailbox exists before the layer finishes building,
    // so an event published immediately after `provide` is still delivered.
    const mailbox = yield* engine.subscribeEvents;
    yield* Stream.runForEach(Stream.fromSubscription(mailbox), react).pipe(Effect.forkScoped);

    // Threads a previous process left stranded: `project.removed` deletes them
    // one at a time off the event above, so a crash in the middle of that would
    // otherwise leave them in the sidebar for good, pointing at no project.
    yield* Effect.gen(function* () {
      for (const doc of yield* engine.threadDocs) {
        if (doc.deleted) {
          continue;
        }
        if ((yield* engine.projectDoc(doc.projectId)) === null) {
          yield* dispatchDelete(doc.threadId);
        }
      }
    }).pipe(
      Effect.catch((error) => Effect.logWarning("orphan thread sweep failed", error)),
      Effect.forkScoped,
    );
  }),
);
