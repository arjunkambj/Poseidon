/**
 * One Command Code session for one thread.
 *
 * Print mode is one turn per process: `send` spawns
 * `cmd -p "<prompt>" --session <sessionId> …` and the harness resumes its own
 * persisted session. What the argv says, and why a plan turn's differs, is
 * `turnArgs.ts`.
 *
 * Three sources feed the event stream: NDJSON frames on stdout, the session
 * transcript the harness appends on disk, and hook posts. The translator —
 * one per session, not per process — dedupes the overlap across turns; the
 * turn-scoped wrapper settles turns.
 */
import * as NodeFS from "node:fs";
import type { ConnectorInstanceId, ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  ConnectorError,
  ConnectorServices,
  TurnInput,
} from "@poseidon/connector-sdk/definition";
import { SessionClosed, SpawnFailed, TurnInProgress } from "@poseidon/connector-sdk/definition";
import { loadSessionPlugins } from "@poseidon/connector-sdk/plugins";
import { makeBoundedEventQueue, type SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import { makeEventId, makeItemId, makeTurnId } from "@poseidon/contracts/ids";

import {
  installProjectHooks,
  uninstallProjectHooks,
  type InstalledFile,
  type McpRegistration,
} from "./config";
import { CMD_CAPABILITIES } from "./capabilities";
import { SIGNAL_DEATHS, awaitExitBriefly, type ActiveProcess } from "./activeProcess";
import { resolveForSession, type ResolvedBinary } from "./binary";
import { ensureHookScript, hookTicketPath, removeHookTicket, writeHookTicket } from "./hookScript";
import { makeHookAnswerer } from "./hookAnswers";
import { makeLineSplitter, parseFrame } from "./ndjson";
import { contextWindowFor } from "./probe";
import { materializePlan, planProposalFor, planWriteIn, releasePlanClaims } from "./plans";
import type { PlanWrite } from "./plans";
import { envAllowlist, spawnProcess } from "./spawn";
import { registerSessionMcp } from "./sessionMcp";
import { prepareTurn } from "./turnArgs";
import { makeSessionRefLocator, type CmdSessionRef } from "./sessionRef";
import { findTranscriptPath, readTranscriptLines, tailTranscript } from "./transcript";
import { makeTranslator, type PendingRuntimeEvent } from "./translate";

/** Re-exported so consumers keep importing the session's own vocabulary from it. */
export type { CmdSessionRef };

export interface CmdSessionOptions {
  readonly instanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly binaryPath?: string;
  /**
   * The executable the probe resolved — command plus the npx fallback's prefix
   * args. Omitted, the session resolves it itself the same way.
   */
  readonly binary?: ResolvedBinary;
  /**
   * Tokens the model can hold. Defaults to what the last probe of this binary
   * reported; a test passes it outright.
   */
  readonly contextLimit?: number | null;
  readonly extraEnv?: Record<string, string>;
  readonly services: ConnectorServices;
  readonly settings: ThreadSettings;
  readonly sessionRef?: CmdSessionRef;
  /**
   * Home directory override for transcript resolution. The harness resolves
   * `~/.commandcode` against `HOME` alone, so a test that points the
   * child's `HOME` aside passes the same directory here.
   */
  readonly home?: string;
}

export const makeCmdSession = (
  options: CmdSessionOptions,
): Effect.Effect<SessionHandle, ConnectorError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* makeBoundedEventQueue();
    const settingsRef = yield* Ref.make(options.settings);
    const processRef = yield* Ref.make<ActiveProcess | null>(null);
    const sessionRef = yield* Ref.make<CmdSessionRef | null>(options.sessionRef ?? null);
    /** Plan files already proposed this session — a settled plan turn must not re-propose. */
    const proposedPlans = yield* Ref.make(new Set<string>());
    /**
     * One send at a time through the check→settle→spawn→install sequence:
     * without the permit, two concurrent sends can both observe `null` in
     * processRef and each spawn a turn.
     */
    const sendMutex = yield* Semaphore.make(1);
    const closedRef = yield* Ref.make(false);
    const scope = yield* Effect.scope;

    // The binary every turn and every `cmd mcp` call of this session spawns,
    // resolved the way the probe resolves it (`binary.ts`) rather than left as
    // the bare name: a packaged .app inherits launchd's PATH, which has no
    // /opt/homebrew/bin. Resolved once — not under a running conversation.
    const binary = yield* Effect.sync(
      (): ResolvedBinary =>
        options.binary ??
        resolveForSession(
          options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath },
          process.env,
        ),
    );

    // The harness slugs its *resolved* cwd into the transcript path — a
    // workspace reached through a symlink (macOS /tmp → /private/tmp) writes
    // under the physical path, so the tailer must watch that one.
    const transcriptRoot = yield* Effect.sync(() => {
      try {
        return NodeFS.realpathSync(options.workspaceRoot);
      } catch {
        return options.workspaceRoot;
      }
    });

    const refs = makeSessionRefLocator({
      root: transcriptRoot,
      ...(options.home === undefined ? {} : { home: options.home }),
    });

    // One translator for the session's whole life: dedupe keys (tool_use.id,
    // messageId) must survive across the one-process-per-turn boundary or the
    // run_end reconcile would re-emit history on every turn.
    const translator = makeTranslator({
      connectorInstanceId: options.instanceId,
      capabilities: CMD_CAPABILITIES,
      resumeAfterMessageId: options.sessionRef?.lastMessageId ?? null,
      // What the last probe of this binary read out of `status --json`. Null
      // until one has run, and then `context.updated` is simply not emitted.
      contextLimit: options.contextLimit ?? contextWindowFor(binary.display),
    });

    const emit = (pending: PendingRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        yield* queue.offer({
          eventId: makeEventId(),
          connectorInstanceId: options.instanceId,
          threadId: options.threadId,
          createdAt: new Date(millis).toISOString(),
          ...pending,
        } as RuntimeEvent);
      });

    /**
     * The translator's `session.started` carries `{sessionId, null, null}` —
     * only this layer knows the workspace — so the full ref the engine
     * persists is filled in here on the way out.
     */
    const enrich = (pending: PendingRuntimeEvent): PendingRuntimeEvent => {
      if (pending.type !== "session.started") {
        return pending;
      }
      const ref = pending.payload.sessionRef as { sessionId?: unknown } | null;
      const sessionId = ref?.sessionId;
      if (typeof sessionId !== "string") {
        return pending;
      }
      return {
        ...pending,
        payload: {
          ...pending.payload,
          sessionRef: {
            sessionId,
            transcriptPath: refs.pathOf(sessionId),
            cwd: options.workspaceRoot,
            lastMessageId: translator.lastMessageId,
          } satisfies CmdSessionRef,
        },
      };
    };

    const emitAll = (pendings: ReadonlyArray<PendingRuntimeEvent>): Effect.Effect<void> =>
      Effect.forEach(pendings, (pending) => emit(enrich(pending)), { discard: true });

    /**
     * Says the session ref again, with the marker the turn just advanced it to.
     *
     * `thread.session.bound` is the marker's only writer and `session.started`
     * the only event that reaches it — emitted once per session, at run_start,
     * before a transcript line has been read, so the stored ref carried
     * `lastMessageId: null` for every session ever started. The fold replaces
     * the ref and nothing else, so saying it again is free.
     */
    const announceRef: Effect.Effect<void> = Effect.gen(function* () {
      const id = translator.sessionId;
      if (id === null) {
        return;
      }
      const settings = yield* Ref.get(settingsRef);
      yield* emit(
        enrich({
          type: "session.started",
          payload: {
            sessionRef: { sessionId: id, transcriptPath: null, cwd: null },
            model: settings.model,
            capabilities: CMD_CAPABILITIES,
          },
        }),
      );
    });

    /**
     * Folds a session's transcript through the translator.
     *
     * With `emitEvents`, this is the drain a turn runs before it settles: the
     * harness's last flush lands *with* `run_end` and the tailer is a poller,
     * so the assistant line carrying `usage.costUsd` reliably arrived after
     * `turn.completed` — after the engine stops tagging events with that turn
     * — and the turn's price was never reported. Re-reading what the tailer
     * already delivered costs nothing: messages dedupe on `meta.messageId` and
     * priced lines on the same id.
     *
     * Without it, this is the seed a resumed session runs before its first
     * turn, up to the marker the previous runtime reached: everything after it
     * is work nobody has been shown and the tailer delivers it, everything
     * before is history, and folding that silently is what keeps the `run_end`
     * reconcile from re-emitting the whole conversation with fresh itemIds. A
     * ref with no marker folds the whole file — which loses the lines written
     * while the server was down, and never shows the conversation twice.
     */
    const foldTranscript = (input: {
      readonly sessionId: string;
      readonly emitEvents: boolean;
      readonly fallbackPath?: string;
      readonly stopAfter?: string | null;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const lines = yield* Effect.sync(() =>
          readTranscriptLines(transcriptRoot, input.sessionId, options.home, input.fallbackPath),
        );
        for (const line of lines) {
          const pendings = yield* Effect.try({
            try: () => translator.onTranscriptLine(JSON.parse(line)),
            catch: (): ReadonlyArray<PendingRuntimeEvent> => [],
          }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<PendingRuntimeEvent>)));
          if (input.emitEvents) {
            yield* emitAll(pendings);
          }
          if (input.stopAfter != null && translator.lastMessageId === input.stopAfter) {
            return;
          }
        }
      });

    const drainTranscript: Effect.Effect<void> = Effect.suspend(() =>
      translator.sessionId === null
        ? Effect.void
        : foldTranscript({ sessionId: translator.sessionId, emitEvents: true }),
    );

    // A resumed session catches its translator up on what a previous runtime
    // already delivered, before its first turn opens.
    if (options.sessionRef !== undefined) {
      yield* foldTranscript({
        sessionId: options.sessionRef.sessionId,
        emitEvents: false,
        fallbackPath: options.sessionRef.transcriptPath,
        stopAfter: options.sessionRef.lastMessageId,
      });
    }

    /**
     * Re-point the stored ref at the transcript now that one exists.
     *
     * The ref is minted at `session.started`, which is `run_start` — seconds
     * before the harness creates the file — so `refs.pathOf` can only hand it
     * the slug guess, and the slug is not the directory the harness uses.
     * Cheap and idempotent: once the lookup has found the real file the path
     * stops changing.
     */
    const refreshTranscriptPath: Effect.Effect<void> = Effect.gen(function* () {
      const ref = yield* Ref.get(sessionRef);
      if (ref === null) {
        return;
      }
      const path = refs.pathOf(ref.sessionId);
      if (path === ref.transcriptPath) {
        return;
      }
      yield* Ref.set(sessionRef, { ...ref, transcriptPath: path });
    });

    /**
     * A plan-mode turn that just ended may have left a plan file behind.
     * Emitted while the turn is still open — after `turn.completed` the engine
     * no longer tags events with its turnId.
     */
    const emitPlanProposal = (active: ActiveProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        const wrote = yield* Ref.get(active.planWrites);
        const seen = yield* Ref.get(proposedPlans);
        const events = yield* Effect.sync(() => {
          // A plan turn carries no `--yolo`, so the harness refused the plan
          // file along with every other write. The body was in the frame that
          // announced the call, so Poseidon saves it.
          if (active.plan) {
            for (const write of wrote) {
              materializePlan(write, options.home);
            }
          }
          return planProposalFor({
            plan: active.plan,
            sessionId: translator.sessionId,
            home: options.home,
            startedAt: active.startedAt,
            wrote: wrote.map((write) => write.file),
            seen,
            ids: () => ({ itemId: makeItemId(), turnId: makeTurnId() }),
          });
        });
        yield* emitAll(events);
      });

    /**
     * A turn that queued tool calls and got no hook post ran ungated.
     *
     * Plan mode is exempt: PreToolUse never fires there, which is why a plan
     * turn is spawned without `--yolo` and leans on print mode's own refusal.
     */
    const warnIfGateWasSilent = (active: ActiveProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (active.plan) {
          return;
        }
        const queued = yield* Ref.get(active.queuedTools);
        const posts = (yield* hookAnswers.postCount) - active.postsAtStart;
        if (queued > 0 && posts === 0) {
          yield* warn(
            `${queued} tool call(s) ran without reaching Poseidon's approval gate — the PreToolUse hook did not fire, so this turn was not gated`,
          );
        }
      });

    /** Everything the PreToolUse bridge needs, kept out of this file. */
    const hookAnswers = yield* makeHookAnswerer({
      threadId: options.threadId,
      services: options.services,
      settings: Ref.get(settingsRef),
      emit,
    });

    // ── session start: hook script + project config + handler ──

    const warn = (message: string): Effect.Effect<void> =>
      options.services.logger
        .log("warn", message)
        .pipe(Effect.andThen(emit({ type: "session.warning", payload: { message } })));

    const hookPath = yield* ensureHookScript().pipe(
      Effect.catch((error) =>
        warn(`could not write the hook script: ${String(error)}`).pipe(Effect.as(null)),
      ),
    );
    // What the hook install below wrote, so close() can put the file back.
    const installedHooks = yield* Ref.make<InstalledFile | null>(null);
    /**
     * What a `cmd mcp` call needs. The environment is the session's own, so
     * the CLI resolves `~/.commandcode` against the same `HOME` its turns do.
     */
    const mcpRegistration: McpRegistration = {
      binaryPath: binary.command,
      ...(binary.prefixArgs.length === 0 ? {} : { prefixArgs: binary.prefixArgs }),
      projectRoot: options.workspaceRoot,
      env: envAllowlist(process.env, { ...options.extraEnv }),
    };
    if (hookPath !== null) {
      // `null` is the install standing down on a file it cannot parse;
      // `undefined` is the write itself failing. Both run the session without
      // the hook, and both say so — the approval gate is off either way.
      const written = yield* installProjectHooks(options.workspaceRoot, hookPath).pipe(
        Effect.catch((error) =>
          warn(`could not install project hooks: ${String(error)}`).pipe(Effect.as(undefined)),
        ),
      );
      if (written === null) {
        yield* warn(
          ".commandcode/settings.local.json is not valid JSON — left it untouched, so tool calls are not gated by Poseidon",
        );
      }
      yield* Ref.set(installedHooks, written ?? null);
    }
    // The enabled plugins, once: their skills go on every turn's argv, their
    // MCP servers into the project's local scope beside Poseidon's own.
    const plugins = yield* loadSessionPlugins(options.services, options.threadId);
    const sessionMcp = yield* registerSessionMcp({
      registration: mcpRegistration,
      services: options.services,
      threadId: options.threadId,
      plugins,
      warn,
    });
    const mcp = sessionMcp.endpoint;
    if (options.services.registerHookHandler !== undefined) {
      yield* options.services.registerHookHandler(options.threadId, hookAnswers.onHookPost);
    }

    /** Wires one spawned process's three sources into the translator. */
    const pump = Effect.fn("CmdSession.pump")(function* (active: ActiveProcess) {
      const proc = active.proc;
      const splitter = makeLineSplitter();
      const transcriptFiber = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);

      // run_start carries the sessionId — that is the first moment the
      // transcript path exists, so the tailer starts there, not at spawn.
      const startTailer = (sessionId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          if ((yield* Ref.get(transcriptFiber)) !== null) return;
          // Located by session id on every poll rather than by the slug: the
          // harness's project-directory naming is not the one `slugFor`
          // guesses, and the file only appears seconds into the turn.
          const locate = (): string | null =>
            findTranscriptPath(transcriptRoot, sessionId, options.home);
          const fiber = yield* tailTranscript(locate, {
            // Where the translator has already read to — the seeded marker on
            // a resumed session, undefined on a fresh one. Lines written while
            // the server was down still arrive; earlier ones do not repeat.
            afterMessageId:
              translator.lastMessageId ?? options.sessionRef?.lastMessageId ?? undefined,
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.flatMap((tailer) =>
              Stream.runForEach(tailer.lines, (line) =>
                Effect.try({
                  try: () => translator.onTranscriptLine(JSON.parse(line)),
                  catch: (): ReadonlyArray<PendingRuntimeEvent> => [
                    {
                      type: "event.unmapped" as const,
                      payload: {},
                      raw: { source: "cmd.transcript", payload: line },
                    },
                  ],
                }).pipe(Effect.flatMap(emitAll)),
              ),
            ),
            Effect.catch(() => Effect.void),
            Effect.forkIn(scope),
          );
          yield* Ref.set(transcriptFiber, fiber);
        });

      // stderr carries "session: <id>" plus progress; drain it so the pipe
      // never back-pressures, and learn the id if run_start has not said it.
      const stderrFiber = yield* Stream.runForEach(proc.stderr, (chunk) =>
        Effect.gen(function* () {
          const match = /^session:\s*(\S+)/m.exec(chunk);
          if (match?.[1] !== undefined && translator.sessionId === null) {
            yield* startTailer(match[1]);
          }
          yield* options.services.logger.log("debug", `cmd stderr: ${chunk.trimEnd()}`);
        }),
      ).pipe(
        Effect.catch(() => Effect.void),
        Effect.forkIn(scope),
      );

      /**
       * Emits one translated event with the bookkeeping that hangs off it: a
       * plan proposal must go out before its turn.completed (once the turn
       * settles, the engine stops tagging events with its turnId), and
       * turnDone flips before the completion event so a consumer that sees it
       * and immediately sends cannot slip between the two steps.
       */
      const emitPrepared = (pending: PendingRuntimeEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          const prepared = enrich(pending);
          if (prepared.type === "turn.completed") {
            yield* warnIfGateWasSilent(active);
            // The last transcript flush precedes the exit, not `run_end`.
            yield* awaitExitBriefly(active);
            yield* drainTranscript;
            yield* refreshTranscriptPath;
            yield* emitPlanProposal(active);
            yield* Deferred.succeed(active.turnDone, undefined);
          }
          yield* emit(prepared);
          if (prepared.type === "session.started") {
            const ref = prepared.payload.sessionRef as { sessionId?: string };
            if (typeof ref.sessionId === "string") {
              // Persist the ref the moment the harness names the session —
              // not just at process exit — so a `sessionRef()` read during or
              // right after the turn already resolves.
              yield* Ref.set(sessionRef, {
                sessionId: ref.sessionId,
                transcriptPath: refs.pathOf(ref.sessionId),
                cwd: options.workspaceRoot,
                lastMessageId: translator.lastMessageId,
              });
              yield* startTailer(ref.sessionId);
            }
          }
        });

      /** One complete stdout line → its events. */
      const handleLine = (line: string): Effect.Effect<void> => {
        const frame = parseFrame(line);
        if ("line" in frame) {
          return emitPrepared({
            type: "event.unmapped",
            payload: {},
            raw: { source: "cmd.ndjson", payload: frame },
          });
        }
        // A plan turn writes its plan with an ordinary `write_file`, and this
        // is the only place its name appears tied to this run.
        const planFile = planWriteIn(frame);
        const queued =
          "event" in frame && frame.event.type === "tool_queued"
            ? Ref.update(active.queuedTools, (count) => count + 1)
            : Effect.void;
        const pendings = translator.onFrame(frame);
        return queued.pipe(
          Effect.andThen(() =>
            planFile === null
              ? Effect.void
              : Ref.update(active.planWrites, (files) => [...files, planFile]),
          ),
          Effect.andThen(() => Effect.forEach(pendings, emitPrepared, { discard: true })),
        );
      };

      const stdoutFiber = yield* Stream.runForEach(proc.stdout, (chunk) =>
        Effect.gen(function* () {
          const pushed = splitter.push(chunk);
          yield* Effect.forEach(pushed.lines, handleLine, { discard: true });
          if (pushed.overflow !== null) {
            // The tail exceeded the line cap and was dropped. `event.unmapped`
            // is where ingestion sends frames it does not recognize — nothing
            // downstream shows one — so a lost `run_end` said nothing at all.
            // A warning does, and the head of the line names the frame.
            yield* warn(
              `dropped a ${pushed.overflow.droppedChars}-character line from the harness: ${pushed.overflow.head}`,
            );
          }
        }),
      ).pipe(
        // EOF: the final frame may be missing its trailing newline — flush
        // the split tail rather than drop the run's last word.
        Effect.andThen(() => {
          const tail = splitter.flush();
          return tail === null ? Effect.void : handleLine(tail);
        }),
        Effect.catch(() => Effect.void),
        Effect.forkIn(scope),
      );

      const exitCode = yield* proc.exitCode;
      // Exit resolves before the pipes finish draining — let the stdout
      // reader run out the buffered chunks and the unterminated tail (EOF
      // flush) before teardown. A grandchild that inherited the pipe holds it
      // open forever; the timeout keeps that from wedging the pump.
      yield* Effect.raceFirst(Fiber.await(stdoutFiber), Effect.sleep("2 seconds"));
      if (translator.sessionId !== null) {
        yield* Ref.set(sessionRef, {
          sessionId: translator.sessionId,
          transcriptPath: refs.pathOf(translator.sessionId),
          cwd: options.workspaceRoot,
          lastMessageId: translator.lastMessageId,
        });
        yield* announceRef;
      }
      yield* hookAnswers.releasePending;
      // A child we killed ourselves reads as an interrupt whatever signal
      // finished it off: the escalation ladder ends in SIGKILL, which node
      // reports as a null code (-1), and that must not settle the turn
      // "error" or look like a crash to the supervisor.
      const interrupted = yield* Ref.get(active.interrupted);
      const code = interrupted && exitCode !== 130 ? 130 : exitCode;
      // Whatever onExit emits, no turn can still be in progress under a dead
      // process — flip before the emits so a consumer that sees the
      // completion and immediately sends cannot slip between them.
      yield* Deferred.succeed(active.turnDone, undefined);
      yield* Effect.forEach(translator.onExit(code), emitPrepared, { discard: true });
      yield* Ref.set(processRef, null);
      yield* Fiber.interrupt(stdoutFiber);
      yield* Fiber.interrupt(stderrFiber);
      const tailer = yield* Ref.get(transcriptFiber);
      if (tailer !== null) yield* Fiber.interrupt(tailer);
      // A signal death nobody asked for is a crash: without a `session.ended`
      // the stream stays open, the supervisor never hears about it and the
      // thread is stuck on a turn that will never finish. Ending it here is
      // what lets the supervisor resume from the persisted sessionRef.
      if (!interrupted && SIGNAL_DEATHS.has(exitCode)) {
        yield* endSession("crashed", exitCode);
      }
      // The slot is free only now: bookkeeping — onExit events, the sessionRef
      // persist — is what a follow-up send must wait out, not just the exit.
      yield* Deferred.succeed(active.settled, undefined);
    });

    const send = (turn: TurnInput): Effect.Effect<void, ConnectorError> =>
      sendMutex
        .withPermit(
          Effect.gen(function* () {
            if (yield* Ref.get(closedRef)) {
              return yield* new SessionClosed({ threadId: options.threadId });
            }
            const previous = yield* Ref.get(processRef);
            if (previous !== null) {
              if (!(yield* Deferred.isDone(previous.turnDone))) {
                // Caller queues the next turn; print mode runs one turn per process.
                return yield* new TurnInProgress({
                  threadId: options.threadId,
                  activeTurnId: null,
                });
              }
              // turn.completed already left but the child is mid-reap — wait
              // the pump out rather than report a turn that no longer exists.
              yield* Deferred.await(previous.settled);
            }
            const settings = yield* Ref.get(settingsRef);
            const stored = yield* Ref.get(sessionRef);
            // Resuming an id the harness has no transcript for fails the whole
            // run, so the locator asks the filesystem first. Losing the model's
            // own memory of a turn it never finished is the smaller loss, and
            // the warning says so rather than letting the context quietly
            // shrink. See `sessionRef.ts` for what the harness does instead.
            const prior = refs.resumable(stored);
            if (stored !== null && prior === null) {
              yield* warn(
                "the previous session left no transcript to resume — it was interrupted before the harness wrote one; continuing in a new session",
              );
            }
            const hook = yield* options.services.hookEndpoint(options.threadId);
            // The bearer goes to disk, not into the environment: Command Code
            // strips secret-shaped variable names out of a hook's env, which
            // silently turned the whole approval gate off (see hookScript.ts).
            const ticket = hookTicketPath(options.threadId);
            yield* writeHookTicket(ticket, hook.bearer).pipe(
              Effect.catch((error) => warn(`could not write the hook ticket: ${String(error)}`)),
            );
            const prepared = yield* Effect.promise(() =>
              prepareTurn({
                turn,
                settings,
                attachmentsDir: options.services.attachmentsDir,
                threadId: options.threadId,
                resumeSessionId: prior?.sessionId ?? null,
                plugins,
              }),
            );
            for (const message of prepared.warnings) {
              yield* warn(message);
            }
            const plan = prepared.plan;
            const proc = yield* spawnProcess({
              binaryPath: binary.command,
              args: [...binary.prefixArgs, ...prepared.args],
              cwd: options.workspaceRoot,
              env: envAllowlist(
                process.env,
                { ...options.extraEnv },
                {
                  POSEIDON_HOOK_URL: hook.url,
                  // A path, not a secret — see the ticket comment above.
                  POSEIDON_HOOK_TICKET_FILE: ticket,
                  POSEIDON_THREAD_ID: options.threadId,
                  ...(mcp === null ? {} : { POSEIDON_MCP_TOKEN: mcp.bearer }),
                },
              ),
            }).pipe(Effect.provideService(Scope.Scope, scope));
            const active: ActiveProcess = {
              proc,
              queuedTools: yield* Ref.make(0),
              postsAtStart: yield* hookAnswers.postCount,
              turnDone: yield* Deferred.make<void>(),
              settled: yield* Deferred.make<void>(),
              plan,
              startedAt: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
              planWrites: yield* Ref.make<ReadonlyArray<PlanWrite>>([]),
              interrupted: yield* Ref.make(false),
            };
            yield* Ref.set(processRef, active);
            yield* pump(active).pipe(Effect.forkIn(scope));
          }),
        )
        .pipe(
          Effect.mapError((error): ConnectorError =>
            error instanceof SessionClosed || error instanceof TurnInProgress
              ? error
              : new SpawnFailed({
                  kind: "cmd",
                  instanceId: options.instanceId,
                  message: error instanceof Error ? error.message : String(error),
                }),
          ),
        );

    /**
     * The one way a session ends: `stopped` when the caller closed it,
     * `crashed` when the child died on a signal nobody asked for. Both revoke
     * the bearer, put the project config back and end the stream — the
     * supervisor only gets to resume when the stream carries `crashed`.
     */
    const endSession = (reason: "stopped" | "crashed", exitCode?: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) {
          return;
        }
        yield* Ref.set(closedRef, true);
        // The plans this session claimed go back into the pool: another
        // thread's mtime scan may consider them again.
        const claimedBy = translator.sessionId;
        if (claimedBy !== null) {
          yield* Effect.sync(() => releasePlanClaims(claimedBy));
        }
        // The session's processes are gone once this returns — revoke the hook
        // bearer with them rather than leave it valid until the scope ends.
        if (options.services.unregisterHookHandler !== undefined) {
          yield* options.services
            .unregisterHookHandler(options.threadId)
            .pipe(Effect.catch(() => Effect.void));
        }
        const active = yield* Ref.get(processRef);
        if (active !== null) {
          yield* active.proc.kill;
        }
        yield* hookAnswers.releasePending;
        // The project is the user's, not ours: the hook block and the MCP entries
        // go out with the session that put them there. Both reverts no-op when
        // the file has changed since or another session still holds it.
        const hooks = yield* Ref.get(installedHooks);
        if (hooks !== null && hookPath !== null) {
          yield* uninstallProjectHooks(options.workspaceRoot, hookPath, hooks).pipe(
            Effect.catch(() => Effect.void),
          );
        }
        yield* sessionMcp.release;
        // The bearer outlives nothing: the session that minted it is over.
        yield* removeHookTicket(hookTicketPath(options.threadId)).pipe(
          Effect.catch(() => Effect.void),
        );
        yield* emit({
          type: "session.ended",
          payload: { reason, ...(exitCode === undefined ? {} : { exitCode }) },
        });
        yield* queue.end;
      });

    const close: Effect.Effect<void> = endSession("stopped");

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (options.services.unregisterHookHandler !== undefined) {
          yield* options.services
            .unregisterHookHandler(options.threadId)
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* close;
      }),
    );

    return {
      events: queue.events,
      send,
      // SIGINT to the process group, SIGKILL after 5s, then a
      // descendant sweep. A bare SIGINT leaves a child that ignores it — or a
      // shell_command grandchild holding the pipe — running forever, and with
      // it a turn that never settles and a thread that can never send again.
      interrupt: () =>
        Ref.get(processRef).pipe(
          Effect.flatMap((active) =>
            active === null
              ? Effect.void
              : Ref.set(active.interrupted, true).pipe(Effect.andThen(active.proc.kill)),
          ),
        ),
      respondToRequest: hookAnswers.respondToRequest,
      respondToUserInput: hookAnswers.respondToUserInput,
      respondToPlan: () => Effect.void, // plan-mode turns answer through send()
      updateSettings: (patch) => Ref.update(settingsRef, (settings) => ({ ...settings, ...patch })),
      sessionRef: () => Ref.get(sessionRef),
      close: () => close,
    };
  });
