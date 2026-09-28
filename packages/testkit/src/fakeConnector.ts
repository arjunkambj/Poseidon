/**
 * A connector with no harness behind it.
 *
 * Everything above the connector layer — the orchestration engine, the
 * transport, the renderer's atoms — has to be testable without a CLI, an
 * account or credits. `makeFakeConnector` is that: a real
 * `ConnectorDefinition` whose sessions replay a scripted list of runtime events
 * per turn, and expose the controls a test actually needs: pause the replay
 * mid-turn, push an extra event in, crash the process, and read back every call
 * the code under test made.
 *
 * With `capabilities.steering` on, a session also offers `steer`: the message
 * is recorded as a call and the running turn simply goes on, which is all the
 * SPI promises. The fake stands in for no harness's way of answering it.
 *
 * With a scripted `generateText`, an instance also offers the one-shot
 * `generateText` and declares `textGeneration`. It is the test's own function,
 * called in process: there is no harness to record, so nothing here pretends
 * to be one.
 *
 * Two rules are enforced by the fake rather than by the script, because they
 * are the ones the engine depends on and a hand-written script would forget:
 * a turn always opens with `turn.started` and always closes with exactly one
 * `turn.completed`, and a turn does not complete while an approval request it
 * opened is still unanswered.
 */

import { makeEventId, makeItemId, makeRequestId, makeTurnId } from "@poseidon/contracts/ids";
import type { ConnectorInstanceId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import type { ConnectorCapabilities, RuntimeEvent } from "@poseidon/contracts/runtime";
import type { ConnectorMetadata, ModelOption } from "@poseidon/contracts/connectors";
import { settingsForm } from "@poseidon/contracts/settings";
import type {
  ConnectorDefinition,
  ConnectorInstance,
  ConnectorError,
  ConnectorProbe,
  GenerateTextInput,
  TurnInput,
} from "@poseidon/connector-sdk/definition";
import { NotSteerable, SessionClosed, TurnInProgress } from "@poseidon/connector-sdk/definition";
import type { ConnectorExtensions } from "@poseidon/connector-sdk/extensions";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import { makeBoundedEventQueue } from "@poseidon/connector-sdk/sessionHandle";
import { uuidV7 } from "@poseidon/shared/ids";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// ── Scripts ────────────────────────────────────────────────────

type WithoutEnvelope<Event> = Event extends RuntimeEvent
  ? Omit<Event, "eventId" | "connectorInstanceId" | "threadId" | "createdAt">
  : never;

/**
 * A runtime event minus the envelope fields the fake fills in. The union still
 * correlates `type` with `payload`, so a script that pairs the wrong two does
 * not compile.
 */
export type ScriptedRuntimeEvent = WithoutEnvelope<RuntimeEvent>;

export interface FakeTurnContext {
  readonly threadId: ThreadId;
  readonly connectorInstanceId: ConnectorInstanceId;
  readonly turnId: TurnId;
  /** 0 for the first turn of the session. */
  readonly turnIndex: number;
  readonly input: TurnInput;
}

/**
 * The body of one turn. `turn.started` and `turn.completed` are the fake's
 * business; a script that emits its own `turn.completed` keeps it and the fake
 * adds none.
 */
export type FakeTurnScript = (context: FakeTurnContext) => ReadonlyArray<ScriptedRuntimeEvent>;

/** One assistant message, streamed in as a real harness would. */
export const defaultTurnScript: FakeTurnScript = ({ input, turnId }) => {
  const itemId = makeItemId();
  const text = `Fake reply to: ${input.text}`;
  return [
    {
      itemId,
      type: "item.started",
      payload: { item: { itemId, kind: "assistant_message", status: "in_progress" } },
    },
    { itemId, type: "content.delta", payload: { itemId, kind: "text", delta: text } },
    {
      itemId,
      type: "item.completed",
      payload: { item: { itemId, kind: "assistant_message", status: "completed", text } },
    },
    {
      type: "usage.updated",
      payload: { turnId, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  ];
};

/**
 * A turn that stops on an approval request. The fake holds `turn.completed`
 * back until the request is answered, so this is what the conformance suite's
 * request case runs against.
 */
export const approvalTurnScript: FakeTurnScript = ({ input }) => {
  const requestId = makeRequestId();
  return [
    {
      requestId,
      type: "request.opened",
      payload: {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: input.text },
          description: `Run ${input.text}`,
        },
      },
    },
  ];
};

// ── Recorded calls ─────────────────────────────────────────────

export type FakeSessionMethod =
  | "send"
  | "steer"
  | "interrupt"
  | "respondToRequest"
  | "respondToUserInput"
  | "respondToPlan"
  | "updateSettings"
  | "sessionRef"
  | "close";

export interface FakeSessionCall {
  readonly method: FakeSessionMethod;
  readonly detail: Readonly<Record<string, unknown>>;
}

// ── One fake session ───────────────────────────────────────────

export interface FakeSession {
  readonly threadId: ThreadId;
  readonly handle: SessionHandle;
  /** Pushes one event onto the session's stream, envelope filled in. */
  readonly emit: (event: ScriptedRuntimeEvent) => Effect.Effect<void>;
  /** Suspends the script replay before its next event. */
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
  /** Ends the session the way a killed process would. */
  readonly crash: (options?: { readonly exitCode?: number }) => Effect.Effect<void>;
  /** What `close` and `crash` prove: the imaginary process tree is gone. */
  readonly processGone: Effect.Effect<boolean>;
  readonly calls: Effect.Effect<ReadonlyArray<FakeSessionCall>>;
}

interface FakeSessionInput {
  readonly connectorInstanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
  readonly model: string;
  readonly capabilities: ConnectorCapabilities;
  readonly script: FakeTurnScript;
  readonly sessionRef: unknown;
  readonly refuseSteering: boolean;
}

const makeFakeSession = (input: FakeSessionInput): Effect.Effect<FakeSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* makeBoundedEventQueue();
    const calls = yield* Ref.make<ReadonlyArray<FakeSessionCall>>([]);
    const gone = yield* Ref.make(false);
    const closed = yield* Ref.make(false);
    const interrupted = yield* Ref.make(false);
    const activeTurn = yield* Ref.make<TurnId | null>(null);
    const turnCount = yield* Ref.make(0);
    const openRequests = yield* Ref.make<ReadonlySet<string>>(new Set());
    const settled = yield* Ref.make<Deferred.Deferred<void> | null>(null);
    const replay = yield* Latch.make(true);
    const turns = yield* Queue.make<
      { readonly turnId: TurnId; readonly input: TurnInput },
      Cause.Done
    >({ capacity: 64 });

    const record = (
      method: FakeSessionMethod,
      detail: Readonly<Record<string, unknown>> = {},
    ): Effect.Effect<void> => Ref.update(calls, (all) => [...all, { method, detail }]);

    const releaseSettled: Effect.Effect<void> = Ref.getAndSet(settled, null).pipe(
      Effect.flatMap((deferred) =>
        deferred === null ? Effect.void : Deferred.succeed(deferred, undefined),
      ),
      Effect.asVoid,
    );

    /**
     * Keeps the open-request set in step with what actually went on the stream,
     * whatever put it there — a script, or `respondToRequest`.
     */
    const trackRequests = (event: RuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.type === "request.opened") {
          yield* Ref.update(openRequests, (all) =>
            new Set(all).add(event.payload.request.requestId),
          );
          return;
        }
        if (event.type === "user-input.requested") {
          yield* Ref.update(openRequests, (all) => new Set(all).add(event.payload.requestId));
          return;
        }
        if (event.type !== "request.resolved" && event.type !== "user-input.resolved") {
          return;
        }
        const emptied = yield* Ref.modify(openRequests, (all) => {
          const next = new Set(all);
          next.delete(event.payload.requestId);
          return [next.size === 0, next] as const;
        });
        if (emptied) {
          yield* releaseSettled;
        }
      });

    const emit = (scripted: ScriptedRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const event: RuntimeEvent = {
          eventId: makeEventId(),
          connectorInstanceId: input.connectorInstanceId,
          threadId: input.threadId,
          createdAt: new Date(millis).toISOString(),
          ...scripted,
        };
        yield* queue.offer(event);
        yield* trackRequests(event);
      });

    /** Waits until nothing the turn opened is still waiting on the user. */
    const awaitRequestsSettled: Effect.Effect<void> = Effect.gen(function* () {
      const deferred = yield* Deferred.make<void>();
      const pending = yield* Ref.get(openRequests);
      if (pending.size === 0) {
        return;
      }
      yield* Ref.set(settled, deferred);
      // Re-check after registering: an answer, or an interrupt, may have landed
      // in between, and this is the only wait that could otherwise never end.
      const stillPending = yield* Ref.get(openRequests);
      if (stillPending.size === 0 || (yield* Ref.get(interrupted))) {
        yield* releaseSettled;
        return;
      }
      yield* Deferred.await(deferred);
    });

    const runTurn = (turn: {
      readonly turnId: TurnId;
      readonly input: TurnInput;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnIndex = yield* Ref.modify(turnCount, (seen) => [seen, seen + 1] as const);
        yield* Ref.set(interrupted, false);
        yield* emit({
          turnId: turn.turnId,
          type: "turn.started",
          payload: { turnId: turn.turnId },
        });

        let scriptedCompletion = false;
        const body = input.script({
          threadId: input.threadId,
          connectorInstanceId: input.connectorInstanceId,
          turnId: turn.turnId,
          turnIndex,
          input: turn.input,
        });

        for (const scripted of body) {
          yield* replay.await;
          if (yield* Ref.get(interrupted)) {
            break;
          }
          yield* emit({ turnId: turn.turnId, ...scripted });
          if (scripted.type === "turn.completed") {
            scriptedCompletion = true;
          }
        }

        if (!scriptedCompletion && !(yield* Ref.get(interrupted))) {
          yield* awaitRequestsSettled;
        }

        const wasInterrupted = yield* Ref.get(interrupted);
        // The turn is free again *before* its completion is visible, so a
        // caller that waits for `turn.completed` can send the next turn at once.
        yield* Ref.set(activeTurn, null);
        if (!scriptedCompletion) {
          yield* emit({
            turnId: turn.turnId,
            type: "turn.completed",
            payload: {
              turnId: turn.turnId,
              stopReason: wasInterrupted ? "interrupted" : "end_turn",
            },
          });
        }
      });

    yield* Effect.forkScoped(Stream.runForEach(Stream.fromQueue(turns), runTurn));

    yield* emit({
      type: "session.started",
      payload: {
        sessionRef: input.sessionRef,
        model: input.model,
        capabilities: input.capabilities,
      },
    });

    const teardown = (reason: "stopped" | "crashed", exitCode?: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) {
          return;
        }
        yield* Ref.set(closed, true);
        yield* Ref.set(interrupted, true);
        yield* replay.open;
        yield* releaseSettled;
        yield* Queue.end(turns);
        yield* emit({
          type: "session.ended",
          payload: { reason, ...(exitCode === undefined ? {} : { exitCode }) },
        });
        yield* Ref.set(gone, true);
        yield* queue.end;
      });

    const refuseWhenClosed = Effect.gen(function* () {
      if (yield* Ref.get(closed)) {
        return yield* Effect.fail(new SessionClosed({ threadId: input.threadId }));
      }
    });

    /**
     * Takes a message into the running turn: recorded, and nothing else — the
     * turn's script carries on and completes it as before. Refused with no turn
     * running, as the SPI says, or always when the test asked for a harness
     * that advertises steering and then turns the message away.
     */
    const steer = (turn: TurnInput): Effect.Effect<void, NotSteerable | SessionClosed> =>
      Effect.gen(function* () {
        yield* record("steer", {
          text: turn.text,
          attachments: turn.attachments,
          mentions: turn.mentions,
        });
        yield* refuseWhenClosed;
        if (input.refuseSteering) {
          return yield* Effect.fail(
            new NotSteerable({ threadId: input.threadId, reason: "the fake refuses steering" }),
          );
        }
        if ((yield* Ref.get(activeTurn)) === null) {
          return yield* Effect.fail(
            new NotSteerable({ threadId: input.threadId, reason: "no turn is running" }),
          );
        }
      });

    const handle: SessionHandle = {
      events: queue.events,
      send: (turn) =>
        Effect.gen(function* () {
          yield* record("send", {
            text: turn.text,
            attachments: turn.attachments,
            mentions: turn.mentions,
            references: turn.references ?? [],
          });
          yield* refuseWhenClosed;
          const active = yield* Ref.get(activeTurn);
          if (active !== null && !input.capabilities.steering) {
            return yield* Effect.fail(
              new TurnInProgress({ threadId: input.threadId, activeTurnId: active }),
            );
          }
          const turnId = makeTurnId();
          yield* Ref.set(activeTurn, turnId);
          yield* Queue.offer(turns, { turnId, input: turn });
        }),
      ...(input.capabilities.steering ? { steer } : {}),
      interrupt: () =>
        Effect.gen(function* () {
          yield* record("interrupt");
          yield* Ref.set(interrupted, true);
          yield* replay.open;
          yield* releaseSettled;
        }),
      respondToRequest: (requestId, decision, updatedInput) =>
        Effect.gen(function* () {
          yield* record("respondToRequest", { requestId, decision, updatedInput });
          yield* emit({ requestId, type: "request.resolved", payload: { requestId, decision } });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          yield* record("respondToUserInput", { requestId, answers });
          yield* emit({ requestId, type: "user-input.resolved", payload: { requestId } });
        }),
      respondToPlan: (turnId, action, feedback) =>
        record("respondToPlan", { turnId, action, feedback }),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          yield* record("updateSettings", { patch });
          if (patch.model !== undefined) {
            yield* emit({
              type: "model.changed",
              payload: {
                model: patch.model,
                ...(patch.effort === undefined ? {} : { effort: patch.effort }),
              },
            });
          }
        }),
      sessionRef: () => record("sessionRef").pipe(Effect.as(input.sessionRef)),
      close: () => record("close").pipe(Effect.andThen(teardown("stopped"))),
    };

    return {
      threadId: input.threadId,
      handle,
      emit,
      pause: replay.close.pipe(Effect.asVoid),
      resume: replay.open.pipe(Effect.asVoid),
      crash: (options) => teardown("crashed", options?.exitCode ?? 137),
      processGone: Ref.get(gone),
      calls: Ref.get(calls),
    };
  });

// ── The connector ──────────────────────────────────────────────

export const FakeConnectorConfig = Schema.Struct({
  label: Schema.optional(Schema.String).pipe(settingsForm({ label: "Label", control: "text" })),
});
export type FakeConnectorConfig = typeof FakeConnectorConfig.Type;

export const FAKE_CONNECTOR_KIND = "fake";

const DEFAULT_CAPABILITIES: ConnectorCapabilities = {
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  steering: false,
  planMode: true,
  subagents: true,
  images: false,
  resume: true,
  fork: true,
  interrupt: "turn",
  rollback: false,
  compaction: false,
  questions: true,
  runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  attachments: "images",
};

export interface FakeConnectorOptions {
  readonly kind?: string;
  /** Overrides the default metadata field by field. */
  readonly metadata?: Partial<ConnectorMetadata>;
  /** Shorthand for `metadata.displayName`. */
  readonly displayName?: string;
  readonly capabilities?: Partial<ConnectorCapabilities>;
  readonly models?: ReadonlyArray<ModelOption>;
  readonly model?: string;
  readonly script?: FakeTurnScript;
  /**
   * With `capabilities.steering` on, makes every `steer` fail with
   * `NotSteerable` — the path where a message meant for the running turn has
   * to fall back to the queue.
   */
  readonly refuseSteering?: boolean;
  /** Handed to every instance as-is; tests supply in-memory ones. */
  readonly extensions?: ConnectorExtensions;
  /**
   * What every instance's `generateText` answers, given the instance it was
   * called on. Present, it also turns `textGeneration` on unless
   * `capabilities` says otherwise; absent, instances have no `generateText`.
   */
  readonly generateText?: (
    input: GenerateTextInput,
    instanceId: ConnectorInstanceId,
  ) => Effect.Effect<string, ConnectorError>;
}

export interface FakeConnector {
  readonly definition: ConnectorDefinition<FakeConnectorConfig>;
  readonly capabilities: ConnectorCapabilities;
  /** Every session ever opened, newest last. */
  readonly sessions: Effect.Effect<ReadonlyArray<FakeSession>>;
  /** The most recent session for a thread, if one was opened. */
  readonly session: (threadId: ThreadId) => Effect.Effect<FakeSession | undefined>;
  /** The `isProcessGone` hook the conformance suite needs. */
  readonly processGone: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export const makeFakeConnector = (
  options: FakeConnectorOptions = {},
): Effect.Effect<FakeConnector> =>
  Effect.gen(function* () {
    const kind = options.kind ?? FAKE_CONNECTOR_KIND;
    const generateText = options.generateText;
    const capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...(generateText === undefined ? {} : { textGeneration: true }),
      ...options.capabilities,
    };
    const model = options.model ?? "fake/model";
    const script = options.script ?? defaultTurnScript;
    const models: ReadonlyArray<ModelOption> = options.models ?? [
      { id: model, label: model, family: "fake", efforts: ["low", "medium", "high"] },
    ];
    const opened = yield* Ref.make<ReadonlyArray<FakeSession>>([]);

    const startSession = (
      connectorInstanceId: ConnectorInstanceId,
      threadId: ThreadId,
      sessionRef: unknown,
    ): Effect.Effect<SessionHandle, never, Scope.Scope> =>
      Effect.gen(function* () {
        const session = yield* makeFakeSession({
          connectorInstanceId,
          threadId,
          model,
          capabilities,
          script,
          sessionRef,
          refuseSteering: options.refuseSteering ?? false,
        });
        yield* Ref.update(opened, (all) => [...all, session]);
        return session.handle;
      });

    const probe: ConnectorProbe = {
      status: "ready",
      probedAt: new Date(0).toISOString(),
      binaryPath: "/dev/null",
      version: "0.0.0",
      installed: true,
      auth: "present",
      models,
      warnings: [],
    };

    const definition: ConnectorDefinition<FakeConnectorConfig> = {
      kind,
      metadata: {
        displayName: options.displayName ?? "Fake",
        iconKey: "terminal",
        accent: "#808080",
        ...options.metadata,
      },
      configSchema: FakeConnectorConfig,
      defaultConfig: () => ({}),
      probe: () => Effect.succeed(probe),
      createInstance: ({ instanceId }) =>
        Effect.succeed<ConnectorInstance>({
          instanceId,
          kind,
          capabilities,
          startSession: (sessionInput) =>
            startSession(instanceId, sessionInput.threadId, {
              sessionId: uuidV7(),
              threadId: sessionInput.threadId,
            }),
          resumeSession: (sessionInput) =>
            startSession(instanceId, sessionInput.threadId, sessionInput.sessionRef),
          listModels: () => Effect.succeed(models),
          ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
          ...(generateText === undefined
            ? {}
            : { generateText: (input: GenerateTextInput) => generateText(input, instanceId) }),
        }),
    };

    const session = (threadId: ThreadId): Effect.Effect<FakeSession | undefined> =>
      Ref.get(opened).pipe(
        Effect.map((all) => all.findLast((candidate) => candidate.threadId === threadId)),
      );

    return {
      definition,
      capabilities,
      sessions: Ref.get(opened),
      session,
      processGone: (threadId) =>
        session(threadId).pipe(
          Effect.flatMap((found) =>
            found === undefined ? Effect.succeed(false) : found.processGone,
          ),
        ),
    };
  });
