/**
 * One Codex session for one thread, over one `codex app-server` process.
 *
 * The app-server serves a whole thread: one process, one JSON-RPC connection,
 * and every turn one more `turn/start` on it. The session:
 *
 * 1. spawns the app-server (`launch.ts`) with the child's default-deny
 *    environment, Poseidon's MCP server injected, and its own process group;
 * 2. shakes hands (`initialize`, `initialized`) and opens the thread
 *    (`threadOpen.ts`), so a CLI that cannot start — or cannot open the
 *    thread — fails `startSession` with `SpawnFailed` instead of a thread
 *    that never answers;
 * 3. announces itself with `session.started`, its ref naming the CLI's thread
 *    (`sessionRef.ts`), then translates every notification on one consumer
 *    fiber (`translate/translator.ts`), in the order the server sent them;
 * 4. starts each turn with `turn/start`, naming the model and effort when
 *    they differ from what the CLI's thread holds (`turnSettings.ts`), its
 *    modes again when they changed (`modes.ts`), and its
 *    collaboration mode — plan or default — from the first plan turn on
 *    (`plans.ts`); a
 *    `/compact` turn is `thread/compact/start` instead (`compaction.ts`), and
 *    a message for the running turn is `turn/steer` (`steering.ts`);
 * 5. answers every request the server makes of it: the command, file-change
 *    and MCP tool-call approvals through Poseidon's permission ladder and its
 *    cards (`toolGate.ts`, `mcpApprovals.ts`), the model's questions on the question card
 *    (`questions.ts`), each on a fiber of its own so a card waiting on the
 *    user holds up nothing else; every other request with a safe refusal
 *    (`serverRequests.ts`);
 * 6. closes by ending the server's stdin — it exits on EOF — stopping the
 *    process group and proving it gone (`spawn.ts`).
 *
 * The app-server stopping on its own — the connection closing while the
 * session is open — is a crash: a fatal `runtime.error` naming the server's
 * last stderr line, then `session.ended { reason: "crashed" }`, which the
 * supervisor resumes from.
 */

import type {
  ConnectorError,
  ConnectorServices,
  TurnInput,
} from "@poseidon/connector-sdk/definition";
import { makeApprovalGate } from "@poseidon/connector-sdk/approvalGate";
import {
  NotSteerable,
  SessionClosed,
  SpawnFailed,
  TurnInProgress,
} from "@poseidon/connector-sdk/definition";
import { makeBoundedEventQueue, type SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import type { RuntimeMode } from "@poseidon/contracts/enums";
import type { ConnectorInstanceId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import { makeEventId, makeTurnId } from "@poseidon/contracts/ids";
import type { ThreadSettings, ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import { stageAttachments } from "./attachments";
import type { ResolvedBinary } from "./binary";
import { CODEX_CAPABILITIES } from "./capabilities";
import { isCompactCommand, ThreadCompactStartResponse } from "./compaction";
import { call, initialize } from "./handshake";
import { CODEX_KIND } from "./kind";
import { sessionEnv, sessionServerArgs } from "./launch";
import type { CodexModelFacts } from "./models";
import { APPROVAL_POLICY, sandboxPolicyFor } from "./modes";
import { collaborationModeFor } from "./plans";
import { TurnStartResponse } from "./protocol";
import { makeCodexQuestions, USER_INPUT_REQUEST } from "./questions";
import { makeRpcClient, type RpcServerRequest } from "./rpc";
import { refusalFor } from "./serverRequests";
import type { CodexSessionRef } from "./sessionRef";
import { makeProcessGroup } from "./spawn";
import { steerRefusal, TurnSteerResponse } from "./steering";
import { openThread } from "./threadOpen";
import { isGatedRequest, makeCodexToolGate } from "./toolGate";
import { holdsOf, turnOverrides, turnTarget, type ThreadHolds } from "./turnSettings";
import {
  asRecord,
  asString,
  type Notification,
  type PendingRuntimeEvent,
} from "./translate/pending";
import { makeTranslator } from "./translate/translator";
import { userInput } from "./userInput";

export interface CodexSessionOptions {
  readonly instanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly binary: ResolvedBinary;
  /** The child's environment (`env.ts`); the session adds the MCP bearer. */
  readonly env: Record<string, string>;
  /** What the user types to sign the CLI in, for an error that is the sign-in. */
  readonly loginCommand: string;
  readonly services: ConnectorServices;
  readonly settings: ThreadSettings;
  /** The thread to resume; absent for a fresh one. */
  readonly sessionRef?: CodexSessionRef;
  /** Fork `sessionRef`'s thread into a new one rather than resume it (`threadOpen.ts`). */
  readonly fork?: boolean;
  /** Said once after `session.started` — why a resume became a fresh start. */
  readonly warning?: string;
  /**
   * A model's efforts and default, when the instance has listed its models:
   * an effort the model does not offer is replaced by its own default, named
   * explicitly (`turnSettings.ts`).
   */
  readonly modelFacts?: (model: string) => CodexModelFacts | undefined;
}

/** How long the app-server may take to answer the handshake and open the thread. */
const HANDSHAKE_TIMEOUT = "60 seconds";

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly interrupted: boolean;
  /** A `/compact` turn: the CLI's compaction, whose id only `turn/started` names. */
  readonly compaction: boolean;
  /**
   * The CLI's id for the turn — once `turn/start` answered, or for a
   * compaction once `turn/started` named it; null when it failed to start.
   */
  readonly codexTurnId: Deferred.Deferred<string | null>;
}

type Inbound =
  | { readonly kind: "notification"; readonly notification: Notification }
  | { readonly kind: "request"; readonly request: RpcServerRequest };

export const makeCodexSession = (
  options: CodexSessionOptions,
): Effect.Effect<SessionHandle, ConnectorError, Scope.Scope> =>
  Effect.gen(function* () {
    const { services, threadId } = options;
    const queue = yield* makeBoundedEventQueue();
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const closedRef = yield* Ref.make(false);
    const turnRef = yield* Ref.make<ActiveTurn | null>(null);
    let settings = options.settings;
    /** The mode the CLI's thread last accepted, so a change is sent until it lands. */
    let appliedMode: RuntimeMode = settings.runtimeMode;

    const emit = (pending: PendingRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        yield* queue.offer({
          eventId: makeEventId(),
          connectorInstanceId: options.instanceId,
          threadId,
          createdAt: new Date(millis).toISOString(),
          ...pending,
        } as RuntimeEvent);
      });

    const failed = (message: string) =>
      new SpawnFailed({ kind: CODEX_KIND, instanceId: options.instanceId, message });

    const mcp = yield* services.mcpEndpoint(threadId);
    const group = makeProcessGroup({
      onStderr: (chunk) => {
        void run(services.logger.log("debug", "codex stderr", { chunk }));
      },
    });
    const child = group.spawn({
      command: options.binary.command,
      args: sessionServerArgs(mcp),
      cwd: options.workspaceRoot,
      env: sessionEnv(options.env, mcp),
    });
    const rpc = makeRpcClient(child, {
      onUnparsed: (line) => {
        void run(services.logger.log("debug", "codex unparsed line", { line }));
      },
    });
    // Registered before the first line can be read, so nothing is missed; the
    // consumer below takes them in the order the server sent them.
    const inbox = yield* Queue.unbounded<Inbound>();
    rpc.onNotification((notification) => {
      Queue.offerUnsafe(inbox, { kind: "notification", notification });
    });
    rpc.onRequest((request) => {
      Queue.offerUnsafe(inbox, { kind: "request", request });
    });

    const opened = yield* Effect.gen(function* () {
      yield* initialize(rpc);
      return yield* openThread({
        rpc,
        cwd: options.workspaceRoot,
        settings,
        ...(options.sessionRef === undefined ? {} : { resume: options.sessionRef.threadId }),
        ...(options.fork === true ? { fork: true } : {}),
      });
    }).pipe(
      Effect.mapError((error) => failed(error.message)),
      Effect.timeoutOrElse({
        duration: HANDSHAKE_TIMEOUT,
        orElse: () => Effect.fail(failed("the Codex app-server did not open the thread")),
      }),
      Effect.tapError(() => group.stop),
    );
    const codexThreadId = opened.threadId;
    /**
     * Whether the CLI's thread may carry a collaboration mode, so every turn
     * names its own (`plans.ts`): once a turn named one, or from the start
     * for a resumed or forked thread, which the previous process may have
     * left in plan.
     */
    let carriesMode = options.sessionRef !== undefined && opened.warning === undefined;
    /** The model and effort the CLI's thread holds, so a turn names each change. */
    let holds: ThreadHolds = holdsOf(opened);

    const currentRef = (): CodexSessionRef => ({
      threadId: codexThreadId,
      cwd: options.workspaceRoot,
    });

    const translator = makeTranslator({ loginCommand: options.loginCommand });
    const gate = yield* makeApprovalGate({ permissions: services.permissions, emit });
    /** Where each approval's fiber lives: the session's scope, not the consumer's. */
    const sessionScope = yield* Effect.scope;
    const toolGate = makeCodexToolGate({ threadId, gate, settings: () => settings });
    const questions = makeCodexQuestions({ emit });

    /**
     * The running turn, if `notification` belongs to it. A notification that
     * names another turn of the CLI's — the previous turn's token total a
     * resume restates, say — belongs to none, even while one runs. Until
     * `turn/start` has answered, the running turn's id is not known yet, and
     * the notification waits for it.
     */
    const turnOf = (notification: Notification): Effect.Effect<ActiveTurn | null> =>
      Effect.gen(function* () {
        const turn = yield* Ref.get(turnRef);
        if (turn === null) return null;
        const params = asRecord(notification.params);
        const named = asString(params.turnId) ?? asString(asRecord(params.turn).id);
        if (named === undefined) return turn;
        // A compaction's id comes only with its `turn/started`, which this
        // consumer reads: until then, a turn named is not the compaction's.
        if (turn.compaction && notification.method === "turn/started") {
          yield* Deferred.succeed(turn.codexTurnId, named);
        }
        if (turn.compaction && !(yield* Deferred.isDone(turn.codexTurnId))) return null;
        const running = yield* Deferred.await(turn.codexTurnId);
        return running === null || running === named ? turn : null;
      });

    /** A notification, translated against the turn it belongs to. */
    const onNotification = (notification: Notification): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turn = yield* turnOf(notification);
        if (turn === null && notification.method === "turn/completed") {
          // A completion for a turn other than the running one — the CLI's
          // own, say — must not end Poseidon's, nor fail its rows.
          if ((yield* Ref.get(turnRef)) !== null) {
            yield* services.logger.log("debug", "codex completed a turn it was not running", {
              params: asRecord(notification.params),
            });
            return;
          }
        }
        yield* toolGate.observe(notification);
        yield* questions.observe(notification);
        for (const event of translator.translate(notification, turn)) {
          if (event.type === "turn.completed") {
            yield* Ref.set(turnRef, null);
            const warning = toolGate.ungated();
            if (warning !== undefined) {
              yield* services.logger.log("warn", warning);
              yield* emit({ type: "session.warning", payload: { message: warning } });
            }
          }
          yield* emit(event);
        }
      });

    /**
     * An approval goes to the gate on a fiber of its own — its card may wait
     * on the user for as long as they take, and the notifications behind it
     * must not. Anything else is refused at once.
     */
    const onRequest = (request: RpcServerRequest): Effect.Effect<void> =>
      isGatedRequest(request) || request.method === USER_INPUT_REQUEST
        ? (request.method === USER_INPUT_REQUEST
            ? questions.ask(request)
            : toolGate.answer(request)
          ).pipe(
            Effect.flatMap((outcome) =>
              outcome === null ? Effect.void : rpc.respond(request.id, outcome),
            ),
            Effect.forkIn(sessionScope),
            Effect.asVoid,
          )
        : Effect.gen(function* () {
            const refusal = refusalFor(request);
            yield* rpc.respond(request.id, refusal.outcome);
            if (refusal.warning !== undefined) {
              yield* services.logger.log("warn", refusal.warning, { method: request.method });
              yield* emit({ type: "session.warning", payload: { message: refusal.warning } });
            }
          });

    /**
     * The one way a session ends. `stopped` when the caller closed it,
     * `crashed` when the app-server went away by itself. It resolves only
     * once the process group is proven gone.
     */
    const endSession = (
      reason: "stopped" | "crashed",
      consumer: Fiber.Fiber<unknown> | null,
      exitCode?: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(closedRef, true)) return;
        if (consumer !== null) yield* Fiber.interrupt(consumer);
        // No card outlives the process that asked: each resolves before the end.
        yield* toolGate.closeAll;
        yield* questions.closeAll;
        yield* group.stop;
        if (!(yield* group.isGone)) {
          yield* group.stop;
          if (!(yield* group.isGone)) {
            yield* services.logger.log("error", "codex process group survived close", {
              pids: group.children().map((each) => each.pid),
            });
            return yield* Effect.die(new Error("the Codex process group survived close"));
          }
        }
        yield* emit({
          type: "session.ended",
          payload: { reason, ...(exitCode === undefined ? {} : { exitCode }) },
        });
        yield* queue.end;
      });

    yield* emit({
      type: "session.started",
      payload: {
        sessionRef: currentRef(),
        model: settings.model,
        capabilities: CODEX_CAPABILITIES,
      },
    });
    for (const message of [options.warning, opened.warning]) {
      if (message !== undefined) yield* emit({ type: "session.warning", payload: { message } });
    }

    const consumer = yield* Queue.take(inbox).pipe(
      Effect.flatMap((inbound) =>
        inbound.kind === "notification"
          ? onNotification(inbound.notification)
          : onRequest(inbound.request),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    /** The app-server went away while the session was open: say why, then end as a crash. */
    yield* Effect.promise(() => rpc.closed).pipe(
      Effect.flatMap((reason) =>
        Effect.gen(function* () {
          if (yield* Ref.get(closedRef)) return;
          // What the server said before it went is still worth translating.
          yield* Fiber.interrupt(consumer);
          for (const inbound of yield* Queue.clear(inbox)) {
            if (inbound.kind === "notification") yield* onNotification(inbound.notification);
          }
          const exit = yield* Effect.promise(() => child.exited);
          yield* emit({
            type: "runtime.error",
            payload: { message: `Codex stopped: ${reason}`, fatal: true },
          });
          yield* endSession("crashed", null, exit.code ?? undefined);
        }),
      ),
      Effect.forkScoped,
    );

    const close = endSession("stopped", consumer);
    yield* Effect.addFinalizer(() => close);

    /** What the next turn runs on. */
    const target = () =>
      turnTarget({
        settings,
        opened,
        ...(options.modelFacts === undefined ? {} : { factsFor: options.modelFacts }),
      });

    /**
     * One turn's `turn/start` params, and what the CLI's thread holds once it
     * accepted them — committed by the caller only then.
     */
    const turnParams = (input: ReturnType<typeof userInput>) => {
      const aim = target();
      const overrides = turnOverrides(aim, holds);
      const mode = settings.runtimeMode;
      const modeChanged = mode !== appliedMode;
      const collaborationMode = collaborationModeFor({
        mode: settings.interactionMode,
        carried: carriesMode,
        model: aim.model,
        effort: aim.effort,
      });
      if (collaborationMode !== undefined) carriesMode = true;
      return {
        params: {
          threadId: codexThreadId,
          input,
          ...overrides.params,
          ...(modeChanged
            ? { approvalPolicy: APPROVAL_POLICY, sandboxPolicy: sandboxPolicyFor(mode) }
            : {}),
          ...(collaborationMode === undefined ? {} : { collaborationMode }),
        },
        // A collaboration mode names the model and effort of its own.
        next: collaborationMode === undefined ? overrides.next : aim,
        mode,
      };
    };

    /** The staged attachments of a turn or a steer, their warnings said. */
    const staged = (turn: TurnInput) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          stageAttachments({
            attachmentsDir: services.attachmentsDir,
            threadId,
            attachments: turn.attachments,
          }),
        );
        for (const message of result.warnings) {
          yield* emit({ type: "session.warning", payload: { message } });
        }
        return result;
      });

    /** What starts the CLI's turn: `turn/start`, or `thread/compact/start` for a compaction. */
    const startTurn = (
      turn: TurnInput,
      compaction: boolean,
      codexTurnId: Deferred.Deferred<string | null>,
    ) =>
      compaction
        ? call(rpc, "thread/compact/start", { threadId: codexThreadId }, ThreadCompactStartResponse)
        : Effect.gen(function* () {
            const input = userInput(turn, yield* staged(turn));
            const { params, next, mode } = turnParams(input);
            const response = yield* call(rpc, "turn/start", params, TurnStartResponse);
            // Only an accepted turn changed the thread: a refused one leaves
            // the change to be named again on the next.
            holds = next;
            appliedMode = mode;
            yield* Deferred.succeed(codexTurnId, response.turn.id);
          });

    const send = (turn: TurnInput): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return yield* new SessionClosed({ threadId });
        const codexTurnId = yield* Deferred.make<string | null>();
        const turnId = makeTurnId();
        const compaction = isCompactCommand(turn);
        const claimed = yield* Ref.modify(turnRef, (now): [ActiveTurn | null, ActiveTurn] =>
          now !== null
            ? [now, now]
            : [null, { turnId, interrupted: false, compaction, codexTurnId }],
        );
        if (claimed !== null) {
          return yield* new TurnInProgress({ threadId, activeTurnId: claimed.turnId });
        }
        // Once claimed, the turn is started to the end: a send interrupted
        // halfway would leave a claimed turn the CLI never heard of, or one
        // it runs whose id nothing knows, and either strands the thread.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* toolGate.turnStarted;
            yield* emit({ type: "turn.started", payload: { turnId } });
            yield* startTurn(turn, compaction, codexTurnId).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(codexTurnId, null);
                  if (yield* Ref.get(closedRef)) return;
                  yield* Ref.set(turnRef, null);
                  yield* emit({
                    type: "runtime.error",
                    payload: { message: `Codex refused the turn: ${error.message}`, fatal: false },
                  });
                  yield* emit({ type: "turn.completed", payload: { turnId, stopReason: "error" } });
                }),
              ),
            );
          }),
        );
      });

    const interrupt = (): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        const active = yield* Ref.get(turnRef);
        if (active === null || active.interrupted) return;
        yield* Ref.set(turnRef, { ...active, interrupted: true });
        // Every open card resolves now, and its request is cancelled, which
        // stops the CLI's turn as well; an open question is answered empty.
        yield* toolGate.cancelAll;
        yield* questions.cancelAll;
        const codexTurnId = yield* Deferred.await(active.codexTurnId);
        if (codexTurnId === null) return;
        yield* rpc
          .request("turn/interrupt", { threadId: codexThreadId, turnId: codexTurnId })
          .pipe(
            Effect.catch((error) =>
              services.logger.log("warn", "codex turn/interrupt failed", { error: error.message }),
            ),
          );
      });

    /**
     * A message into the running turn: `turn/steer`, naming the turn the
     * session is running, so the CLI refuses it should that turn have ended
     * meanwhile. No `turn.started`: the CLI keeps the turn, and its one
     * `turn/completed` ends it (`steering.ts`). Any refusal is `NotSteerable`.
     */
    const steer = (turn: TurnInput): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return yield* new SessionClosed({ threadId });
        const active = yield* Ref.get(turnRef);
        const refusal = steerRefusal(active);
        if (refusal !== undefined || active === null) {
          return yield* new NotSteerable({ threadId, reason: refusal ?? "no turn is running" });
        }
        const expectedTurnId = yield* Deferred.await(active.codexTurnId);
        if (expectedTurnId === null) {
          return yield* new NotSteerable({ threadId, reason: "the running turn did not start" });
        }
        const input = userInput(turn, yield* staged(turn));
        yield* call(
          rpc,
          "turn/steer",
          { threadId: codexThreadId, expectedTurnId, input },
          TurnSteerResponse,
        ).pipe(Effect.mapError((error) => new NotSteerable({ threadId, reason: error.message })));
      });

    /**
     * The thread's new settings, kept for the next `turn/start`, which names
     * the model, the effort and the modes where they changed. The CLI takes
     * them per turn, so `model.changed` says at once what the next turn runs
     * on — an effort the new model does not offer as the one it will run at.
     */
    const updateSettings = (patch: ThreadSettingsPatch): Effect.Effect<void> =>
      Effect.gen(function* () {
        const before = settings;
        settings = { ...settings, ...patch };
        if (settings.model === before.model && settings.effort === before.effort) return;
        const effort = settings.effort === undefined ? undefined : target().effort;
        yield* emit({
          type: "model.changed",
          payload: { model: settings.model, ...(effort === undefined ? {} : { effort }) },
        });
      });

    return {
      events: queue.events,
      send,
      steer,
      interrupt,
      respondToRequest: gate.respond,
      respondToUserInput: questions.respond,
      // Nothing is parked on a plan: the plan turn ended when it handed the
      // plan over, and accepting or revising it is the server's next turn.
      respondToPlan: (turnId, action) =>
        services.logger.log("debug", "codex plan answered", { turnId, action }),
      updateSettings,
      sessionRef: () => Effect.sync(currentRef),
      close: () => close,
    };
  });
