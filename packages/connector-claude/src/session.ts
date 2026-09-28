/**
 * One Claude Code session for one thread.
 *
 * Unlike Command Code's one-process-per-turn print mode, one CLI process
 * serves the whole session: the SDK's `query()` runs in streaming-input mode,
 * fed by the session's input queue (`inputQueue.ts`), and every turn is one
 * more user message written to the same process. The session:
 *
 * 1. starts the query and waits for the CLI's initialize handshake, so a CLI
 *    that cannot start — or refuses the session id it was asked to resume —
 *    fails `startSession` with `SpawnFailed` instead of a thread that never
 *    answers;
 * 2. announces itself with `session.started` before any work, its ref naming
 *    the session id it minted (the SDK's `sessionId`) or resumed;
 * 3. translates every SDK message the query yields (`translate/translator.ts`)
 *    on one consumer fiber;
 * 4. gates every tool call through Poseidon's permission ladder
 *    (`toolGate.ts`), from the first message on, and says so with a
 *    `session.warning` if a turn ran a tool call the gate never saw. The
 *    model's questions and plans open Poseidon's cards instead
 *    (`interactions.ts`);
 * 5. closes by releasing open cards, ending the input, closing the query,
 *    stopping the CLI's process group and proving it gone (`spawn.ts`).
 *
 * The CLI's permission mode follows the thread's modes (`permissionModeFor`).
 * The session keeps the mode the CLI last reported or was last set to, and
 * sets it again before a turn whose modes call for another — a plan turn, or
 * the turn after one, whether the thread's modes changed or the model moved
 * the CLI into plan mode by itself.
 *
 * Steering (`steer`) writes one more user message while a turn runs, with no
 * new turn boundary. The CLI either folds it into the running turn or runs it
 * as a turn of its own right after; `steering.ts` reads which from the CLI's
 * receipts, and the session holds Poseidon's turn open across the CLI's
 * `result`s until every steered message has been taken up. Its usage is the
 * sum of those results. Stop ends the whole turn, steered messages included;
 * a held turn whose steered messages all end without a turn of the CLI's
 * ends there, since no `result` will come for it.
 * A CLI that has not shown it sends those receipts is not steered: the steer
 * is refused for the caller to queue, and once its init shows it sends none
 * the session announces `steering: false`.
 *
 * The CLI stopping on its own — the stream ending or failing while the session
 * is open — is a crash: a fatal `runtime.error` naming the CLI's last stderr,
 * then `session.ended { reason: "crashed" }`, which the supervisor resumes from.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { query, type PermissionMode, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeApprovalGate } from "@poseidon/connector-sdk/approvalGate";
import type {
  ConnectorError,
  ConnectorServices,
  TurnInput,
} from "@poseidon/connector-sdk/definition";
import {
  NotSteerable,
  SessionClosed,
  SpawnFailed,
  TurnInProgress,
} from "@poseidon/connector-sdk/definition";
import { makeBoundedEventQueue, type SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import type { ConnectorInstanceId, ItemId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import { makeEventId, makeTurnId } from "@poseidon/contracts/ids";
import type {
  ThreadSettings,
  ThreadSettingsPatch,
  TurnUsage,
} from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { stageAttachments } from "./attachments";
import type { ResolvedBinary } from "./binary";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { makeInputQueue } from "./inputQueue";
import { makeInteractions } from "./interactions";
import { CLAUDE_KIND } from "./kind";
import { sdkModelFor } from "./models";
import { plansDirFor } from "./plans";
import {
  attachmentsDirFor,
  buildQueryOptions,
  permissionModeFor,
  sdkEffortFor,
  type SessionLimits,
} from "./queryOptions";
import { reportedSessionId, type ClaudeSessionRef } from "./sessionRef";
import { makeProcessGroup } from "./spawn";
import { addUsage, makeSteerLedger, type SteerReceipt } from "./steering";
import { makeToolGate } from "./toolGate";
import { asRecord, type PendingRuntimeEvent } from "./translate/pending";
import { isModeReport, makeTranslator } from "./translate/translator";
import { userMessage } from "./userMessage";

export interface ClaudeSessionOptions {
  readonly instanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly binary: ResolvedBinary;
  /** The child's whole environment (`env.ts`). */
  readonly env: Record<string, string>;
  /** What the user types to sign the CLI in, for a request that fails on it. */
  readonly loginCommand: string;
  readonly services: ConnectorServices;
  readonly settings: ThreadSettings;
  /** The session to resume; absent for a fresh one. */
  readonly sessionRef?: ClaudeSessionRef;
  /** Said once after `session.started` — why a resume became a fresh start. */
  readonly warning?: string;
  readonly limits?: SessionLimits;
}

/** How long the CLI may take to answer the SDK's initialize request. */
const HANDSHAKE_TIMEOUT = "60 seconds";
/**
 * How long a CLI that stopped may take to finish writing stderr: its last
 * line can land after its 'exit', and a grandchild holding the pipe must not
 * hold the session with it.
 */
const STDERR_SETTLE = "2 seconds";
/** At most this much of the CLI's stderr goes into a failed handshake's message. */
const HANDSHAKE_TAIL = 500;

/**
 * A failed handshake's message: the SDK's own, then the end of the CLI's
 * stderr. The SDK reads no stderr from a custom spawn (`spawn.ts`), and the
 * CLI's reason — "No conversation found with session ID: …" for a resume of
 * a conversation it no longer has — is only there.
 */
export const handshakeFailureMessage = (cause: string, stderrTail: string): string => {
  const tail = stderrTail.trim();
  if (tail === "") return cause;
  return `${cause}: ${tail.length > HANDSHAKE_TAIL ? `…${tail.slice(-HANDSHAKE_TAIL)}` : tail}`;
};

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly interrupted: boolean;
  /** The translator's count of calls that ran, when the turn began. */
  readonly ranAtStart: number;
  /** The gate's count of calls it saw, when the turn began. */
  readonly sightingsAtStart: number;
  /** The usage of the CLI's results this turn has already spanned (`steering.ts`). */
  readonly usage: TurnUsage | null;
  /**
   * The completion a `result` would have closed the turn with, while the turn
   * is held for a steered message that no CLI turn has started yet.
   */
  readonly held: TurnCompleted | null;
}

type TurnCompleted = Extract<PendingRuntimeEvent, { type: "turn.completed" }>;

/**
 * The SDK's `interrupt`, with the option its runtime reads (0.3.280) but its
 * declarations leave out: `cancelQueued` also cancels every user message
 * still on the CLI's queue (the CLI's `interrupt_cancel_queued_v1`).
 */
type InterruptWithOptions = (options?: { readonly cancelQueued?: boolean }) => Promise<unknown>;

/** What the thread is told when a turn's tool calls ran past the gate. */
export const ungatedWarning = (ran: number): string =>
  `${ran} tool call(s) ran without reaching Poseidon's approval gate — the PreToolUse hook did not fire, so this turn was not gated`;

/**
 * The turn Stop found, and the turn as it stands after: marked interrupted,
 * or still none when no turn runs. Read and written in one `Ref.modify`, so a
 * turn the consumer ends between a read and a write is never written back —
 * a stale turn left in the ref would refuse every later `send`.
 */
export const markInterrupted = <T extends { readonly interrupted: boolean }>(
  now: T | null,
): [T | null, T | null] => (now === null ? [null, null] : [now, { ...now, interrupted: true }]);

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makeClaudeSession = (
  options: ClaudeSessionOptions,
): Effect.Effect<SessionHandle, ConnectorError, Scope.Scope> =>
  Effect.gen(function* () {
    const { services, threadId } = options;
    const queue = yield* makeBoundedEventQueue();
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const closedRef = yield* Ref.make(false);
    const turnRef = yield* Ref.make<ActiveTurn | null>(null);
    // Read synchronously by the SDK's callbacks, so a plain variable.
    let settings = options.settings;

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

    const ledger = makeSteerLedger();
    const translator = makeTranslator({
      loginCommand: options.loginCommand,
      previousTotalCost:
        options.sessionRef === undefined ? 0 : (options.sessionRef.totalCostUsd ?? null),
    });
    // The CLI's permission mode as it last stood — see the header.
    let cliMode: PermissionMode = permissionModeFor(settings);

    const gate = yield* makeApprovalGate({ permissions: services.permissions, emit });
    const interactions = yield* makeInteractions({
      emit,
      // The plan settles its row and raises the card, inside the running turn.
      // ExitPlanMode only runs in the CLI's plan mode, so that is its mode now.
      onPlan: (plan, toolUseId) =>
        Effect.gen(function* () {
          cliMode = "plan";
          for (const event of translator.planProposed(toolUseId, plan.markdown)) {
            yield* emit(event);
          }
          const turn = yield* Ref.get(turnRef);
          if (turn === null) return;
          yield* emit({
            type: "turn.plan.proposed",
            payload: {
              turnId: turn.turnId,
              planMarkdown: plan.markdown,
              ...(plan.path === undefined ? {} : { planPath: plan.path }),
            },
          });
        }),
    });
    const toolGate = makeToolGate({
      threadId,
      permissions: services.permissions,
      gate,
      settings: () => settings,
      run,
      interactions,
      plansDir: plansDirFor(options.env, NodeOS.homedir()),
    });
    const mcp = yield* services.mcpEndpoint(threadId);
    const attachmentsDir = attachmentsDirFor(services.attachmentsDir, threadId);
    yield* Effect.sync(() => {
      try {
        NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      } catch {
        // The CLI only warns about a readable directory that is missing.
      }
    });

    // The CLI's session id: minted or resumed here, then followed across a
    // `/clear`, which starts the conversation over under a new one (`sessionRef.ts`).
    let sessionId = options.sessionRef?.sessionId ?? NodeCrypto.randomUUID();
    const input = makeInputQueue<SDKUserMessage>();
    const group = makeProcessGroup({
      onStderr: (chunk) => {
        void run(services.logger.log("debug", "claude stderr", { chunk }));
      },
    });
    const abortController = new AbortController();
    const session = query({
      prompt: input.iterable,
      options: buildQueryOptions({
        binaryPath: options.binary.command,
        env: options.env,
        cwd: options.workspaceRoot,
        ...(options.sessionRef === undefined ? { sessionId } : { resume: sessionId }),
        settings,
        mcp,
        attachmentsDir,
        abortController,
        spawn: group.spawn,
        gate: toolGate,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      }),
    });

    /** Everything the query started, stopped; used when the start itself fails. */
    const teardown = Effect.gen(function* () {
      input.end();
      yield* Effect.sync(() => session.close());
      abortController.abort();
      yield* group.stop;
    });

    /**
     * The handshake failed: why, with what the CLI said on stderr, read before
     * the teardown stops it. A CLI that failed has exited, and its stderr is
     * waited for to its end — the SDK can reject on the 'exit' that comes
     * before the last line; one that never answered is still running.
     */
    const handshakeFailed = (detail: string, exited: boolean) =>
      Effect.gen(function* () {
        const child = group.latest();
        if (exited && child !== undefined) {
          yield* Effect.promise(() => child.drained).pipe(Effect.timeoutOption(STDERR_SETTLE));
        }
        return yield* new SpawnFailed({
          kind: CLAUDE_KIND,
          instanceId: options.instanceId,
          message: handshakeFailureMessage(detail, child?.stderrTail() ?? ""),
        });
      });

    yield* Effect.tryPromise({
      try: () => session.initializationResult(),
      catch: messageOf,
    }).pipe(
      Effect.catch((detail) => handshakeFailed(detail, true)),
      Effect.timeoutOrElse({
        duration: HANDSHAKE_TIMEOUT,
        orElse: () =>
          handshakeFailed("Claude Code did not answer the SDK's initialize request", false),
      }),
      Effect.tapError(() => teardown),
    );

    const currentRef = (): ClaudeSessionRef => {
      const lastAssistantUuid = translator.lastAssistantUuid();
      const totalCostUsd = translator.totalCost();
      return {
        sessionId,
        cwd: options.workspaceRoot,
        ...(lastAssistantUuid === undefined ? {} : { lastAssistantUuid }),
        ...(totalCostUsd === null ? {} : { totalCostUsd }),
      };
    };

    /** `session.started` again with the ref as it stands — the fold replaces the stored one. */
    const announce = Effect.suspend(() =>
      emit({
        type: "session.started",
        payload: {
          sessionRef: currentRef(),
          model: settings.model,
          // A CLI whose init showed it sends no receipts cannot be steered
          // (`steering.ts`); the next announcement says so.
          capabilities: { ...CLAUDE_CAPABILITIES, steering: ledger.receipts() !== false },
        },
      }),
    );

    /**
     * Every call reaches the hook, and a call the hook passes to `canUseTool`
     * reaches it too; a turn whose calls ran while the gate saw none was not
     * gated, and the thread is told before the turn closes.
     */
    const checkGated = (turn: ActiveTurn): Effect.Effect<void> =>
      Effect.gen(function* () {
        const ran = translator.toolCallsRan() - turn.ranAtStart;
        if (ran === 0 || toolGate.sightings() > turn.sightingsAtStart) return;
        const message = ungatedWarning(ran);
        yield* services.logger.log("warn", message);
        yield* emit({ type: "session.warning", payload: { message } });
      });

    /**
     * A receipt for a steered message, while the turn is held for it. Started:
     * a turn of the CLI's runs for it, and that turn's `result` decides.
     * Dropped with nothing else awaited: no `result` will come, so the turn
     * ends with the completion it was held from — `interrupted` when Stop
     * cancelled the message.
     */
    const settleHeld = (receipt: SteerReceipt): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (receipt === "started") {
          yield* Ref.update(turnRef, (now) =>
            now === null || now.held === null ? now : { ...now, held: null },
          );
          return;
        }
        const ended = yield* Ref.modify(turnRef, (now): [ActiveTurn | null, ActiveTurn | null] =>
          now !== null && now.held !== null && !ledger.awaiting() ? [now, null] : [null, now],
        );
        if (ended === null || ended.held === null) return;
        yield* services.logger.log(
          "debug",
          "claude held turn ended: its steered message ended unrun",
          {
            turnId: ended.turnId,
          },
        );
        const { payload } = ended.held;
        ledger.clear();
        yield* checkGated(ended);
        yield* emit({
          ...ended.held,
          payload: ended.interrupted ? { ...payload, stopReason: "interrupted" } : payload,
        });
        yield* announce;
      });

    const handle = (message: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return;
        const record = asRecord(message);
        if (record.type === "system" && record.subtype === "status" && isModeReport(record)) {
          cliMode = record.permissionMode as PermissionMode;
        }
        sessionId = reportedSessionId(record) ?? sessionId;
        const receipt = ledger.observe(record);
        if (receipt !== null) yield* settleHeld(receipt);
        const turn = yield* Ref.get(turnRef);
        let completed = false;
        for (const event of translator.translate(message, turn)) {
          if (event.type === "usage.updated" && turn !== null) {
            yield* emit(yield* carryUsage(event));
            continue;
          }
          if (event.type === "turn.completed" && turn !== null) {
            // A steered message the CLI has not taken up yet runs next, as a
            // turn of its own: this result is not the end of Poseidon's turn.
            // Decided and cleared in one step, so a steer either lands before
            // (and holds the turn) or finds no turn and is queued instead.
            const ends = yield* Ref.modify(turnRef, (now): [boolean, ActiveTurn | null] =>
              now !== null && !now.interrupted && ledger.awaiting()
                ? [false, { ...now, held: event }]
                : [true, null],
            );
            if (!ends) {
              yield* services.logger.log("debug", "claude turn held open for a steered message", {
                turnId: turn.turnId,
              });
              continue;
            }
            ledger.clear();
            yield* checkGated(turn);
            completed = true;
          }
          yield* emit(event);
        }
        if (completed) yield* announce;
      });

    /** A result's usage, added to what the turn's earlier results reported. */
    const carryUsage = (
      event: Extract<PendingRuntimeEvent, { type: "usage.updated" }>,
    ): Effect.Effect<PendingRuntimeEvent> =>
      Ref.modify(turnRef, (active) => {
        if (active === null) return [event, active];
        const { turnId, ...reported } = event.payload;
        const usage = addUsage(active.usage, reported);
        return [
          { ...event, payload: { turnId, ...usage } },
          { ...active, usage },
        ];
      });

    /**
     * The one way a session ends. `stopped` when the caller closed it,
     * `crashed` when the CLI went away by itself. It resolves only once the
     * process group is proven gone.
     */
    const endSession = (
      reason: "stopped" | "crashed",
      consumerFiber: Fiber.Fiber<void> | null,
      exitCode?: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(closedRef, true)) return;
        yield* gate.releaseAll("deny");
        yield* interactions.releaseAll;
        input.end();
        yield* Effect.sync(() => session.close());
        if (consumerFiber !== null) yield* Fiber.interrupt(consumerFiber);
        abortController.abort();
        yield* group.stop;
        if (!(yield* group.isGone)) {
          yield* group.stop;
          if (!(yield* group.isGone)) {
            yield* services.logger.log("error", "claude process group survived close", {
              pids: group.children().map((child) => child.pid),
            });
            return yield* Effect.die(new Error("the Claude Code process group survived close"));
          }
        }
        yield* emit({
          type: "session.ended",
          payload: { reason, ...(exitCode === undefined ? {} : { exitCode }) },
        });
        yield* queue.end;
      });

    /** The CLI stopped while the session was open: say why, then end as a crash. */
    const crashed = (detail: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return;
        const child = group.latest();
        const exit = child === undefined ? undefined : yield* Effect.promise(() => child.exited);
        if (child !== undefined) {
          yield* Effect.promise(() => child.drained).pipe(Effect.timeoutOption(STDERR_SETTLE));
        }
        const tail = child?.stderrTail().trim().split("\n").at(-1) ?? "";
        yield* emit({
          type: "runtime.error",
          payload: { message: tail === "" ? detail : `${detail}: ${tail}`, fatal: true },
        });
        yield* endSession(
          "crashed",
          null,
          exit?.code === null || exit?.code === undefined ? undefined : exit.code,
        );
      });

    yield* announce;
    if (options.warning !== undefined) {
      yield* emit({ type: "session.warning", payload: { message: options.warning } });
    }

    const consumer = yield* Stream.fromAsyncIterable(session, (cause) => cause).pipe(
      Stream.runForEach(handle),
      Effect.matchEffect({
        onFailure: (cause) => crashed(`Claude Code stopped: ${messageOf(cause)}`),
        onSuccess: () => crashed("Claude Code exited"),
      }),
      Effect.forkScoped,
    );

    const close = endSession("stopped", consumer);
    yield* Effect.addFinalizer(() => close);

    const send = (turn: TurnInput): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return yield* new SessionClosed({ threadId });
        const active = yield* Ref.get(turnRef);
        if (active !== null) {
          return yield* new TurnInProgress({ threadId, activeTurnId: active.turnId });
        }
        const turnId = makeTurnId();
        yield* Ref.set(turnRef, {
          turnId,
          interrupted: false,
          ranAtStart: translator.toolCallsRan(),
          sightingsAtStart: toolGate.sightings(),
          usage: null,
          held: null,
        });
        yield* emit({ type: "turn.started", payload: { turnId } });
        const staged = yield* Effect.promise(() =>
          stageAttachments({
            attachmentsDir: services.attachmentsDir,
            threadId,
            attachments: turn.attachments,
          }),
        );
        for (const message of staged.warnings) {
          yield* emit({ type: "session.warning", payload: { message } });
        }
        // A plan turn needs the CLI in plan mode before it reads the message,
        // and the turn after one needs it out again.
        const mode = permissionModeFor(settings);
        if (mode !== cliMode) yield* applyMode(mode);
        if (!input.push(userMessage(turn, staged))) {
          return yield* new SessionClosed({ threadId });
        }
      });

    /**
     * One more message into the running turn: no `turn.started`, and the
     * turn is held open until the CLI has taken it up (`steering.ts`). The
     * CLI's permission mode is the running turn's; a steer does not move it.
     */
    const steer = (turn: TurnInput): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) return yield* new SessionClosed({ threadId });
        const notRunning = new NotSteerable({ threadId, reason: "no turn is running" });
        const active = yield* Ref.get(turnRef);
        if (active === null) return yield* notRunning;
        if (active.interrupted) {
          return yield* new NotSteerable({ threadId, reason: "the running turn is stopping" });
        }
        if (ledger.receipts() !== true) {
          return yield* new NotSteerable({
            threadId,
            reason: "this Claude Code has not shown it reports what it did with a steered message",
          });
        }
        const staged = yield* Effect.promise(() =>
          stageAttachments({
            attachmentsDir: services.attachmentsDir,
            threadId,
            attachments: turn.attachments,
          }),
        );
        for (const message of staged.warnings) {
          yield* emit({ type: "session.warning", payload: { message } });
        }
        const message = userMessage(turn, staged);
        // Staging awaited the disk: the turn may have ended meanwhile, and a
        // message written now would start one nobody opened.
        // Read and written in one step, so a result the consumer handles
        // meanwhile either sees the message watched or ends the turn first.
        const delivered = yield* Ref.modify(turnRef, (now) => {
          if (now?.turnId !== active.turnId || now.interrupted) return ["ended" as const, now];
          ledger.watch(message.uuid!);
          return [input.push(message) ? ("sent" as const) : ("closed" as const), now];
        });
        if (delivered === "ended") return yield* notRunning;
        if (delivered === "closed") return yield* new SessionClosed({ threadId });
      });

    const interrupt = (): Effect.Effect<void, ConnectorError> =>
      Effect.gen(function* () {
        // Marked in one step: a turn the consumer ended meanwhile stays ended.
        const active = yield* Ref.modify(turnRef, markInterrupted);
        if (active === null) return;
        // A card nobody will answer any more must not hold the stop up.
        yield* gate.releaseAll("deny");
        yield* interactions.releaseAll;
        // A steered message still on the CLI's queue would otherwise run as
        // the next turn once this one stops; Stop stops it too.
        const cancelQueued = ledger.awaiting();
        yield* Effect.tryPromise(() =>
          cancelQueued
            ? (session.interrupt as InterruptWithOptions).call(session, { cancelQueued })
            : session.interrupt(),
        ).pipe(
          Effect.catch((error) =>
            services.logger.log("warn", "claude interrupt failed", { error: error.message }),
          ),
        );
      });

    /** One of the SDK's session controls: true once the CLI took it, logged when it did not. */
    const control = (what: string, call: () => Promise<unknown>): Effect.Effect<boolean> =>
      Effect.tryPromise(call).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          services.logger
            .log("warn", `claude ${what} failed`, { error: error.message })
            .pipe(Effect.as(false)),
        ),
      );

    /**
     * One running subagent stopped through the SDK's `stopTask`, by the CLI's
     * own `task_id` for its row; the CLI then reports the task stopped, which
     * settles the row as failed (`translate/subagents.ts`), and the turn goes
     * on. A row whose task already settled, or whose id the CLI never named,
     * has nothing to stop.
     */
    const stopTask = (itemId: ItemId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const taskId = translator.cliTaskOf(itemId);
        if (taskId === undefined) {
          return yield* services.logger.log("debug", "claude task not running", { itemId });
        }
        yield* control("stopTask", () => session.stopTask(taskId));
      });

    /** The CLI's permission mode, set; kept as `cliMode` once the CLI took it. */
    const applyMode = (mode: PermissionMode): Effect.Effect<void> =>
      Effect.tryPromise(() => session.setPermissionMode(mode)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            cliMode = mode;
          }),
        ),
        Effect.catch((error) =>
          services.logger.log("warn", "claude setPermissionMode failed", { error: error.message }),
        ),
      );

    /**
     * The thread's new settings, applied to the running CLI. The model is the
     * SDK's `setModel` (none for `default`, so the CLI's own default applies
     * again) and the effort its `applyFlagSettings({ effortLevel })`; both
     * take effect from the CLI's next request. Either way `model.changed`
     * then says what the CLI runs on: the new pick once the CLI took it, the
     * one before when it refused, so the thread never shows a model the
     * session is not using.
     */
    const updateSettings = (patch: ThreadSettingsPatch): Effect.Effect<void> =>
      Effect.gen(function* () {
        const before = settings;
        settings = { ...settings, ...patch };
        let switched = false;
        if (settings.model !== before.model) {
          switched = true;
          if (!(yield* control("setModel", () => session.setModel(sdkModelFor(settings.model))))) {
            settings = { ...settings, model: before.model };
          }
        }
        const mode = permissionModeFor(settings);
        if (mode !== cliMode) yield* applyMode(mode);
        if (settings.effort !== before.effort) {
          switched = true;
          const effortLevel = sdkEffortFor(settings.effort) ?? null;
          if (
            !(yield* control("applyFlagSettings", () => session.applyFlagSettings({ effortLevel })))
          ) {
            const { effort: _refused, ...rest } = settings;
            settings = before.effort === undefined ? rest : { ...rest, effort: before.effort };
          }
        }
        if (switched) {
          yield* emit({
            type: "model.changed",
            payload: {
              model: settings.model,
              ...(settings.effort === undefined ? {} : { effort: settings.effort }),
            },
          });
        }
      });

    return {
      events: queue.events,
      send,
      steer,
      interrupt,
      stopTask,
      respondToRequest: (requestId, decision) => gate.respond(requestId, decision),
      respondToUserInput: (requestId, answers) =>
        interactions.respondToUserInput(requestId, answers),
      // Nothing is parked on a plan: its ExitPlanMode call was answered when
      // the plan was captured, and the CLI waits for the next message. What
      // the answer does next — the modes, the implementation or revision turn
      // — the server sends as settings and a turn like any other.
      respondToPlan: (turnId, action) =>
        services.logger.log("debug", "claude plan answered", { turnId, action }),
      updateSettings,
      sessionRef: () => Effect.sync(currentRef),
      close: () => close,
    };
  });
