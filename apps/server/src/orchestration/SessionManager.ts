/**
 * Which connector instance a thread talks to, and the live sessions on top.
 *
 * `ConnectorSelection` is the seam the settings layer fills through the
 * registry (`settings/connectorRouting.ts`). Left to itself it answers "the
 * first instance registered", which is what the fake-connector tests provide.
 * A thread that chose an instance goes to that one while it is open. Routing
 * on a thread that already has a session always goes by the persisted
 * `connectorInstanceId` — two instances of the same kind can differ in binary,
 * credentials and model, so kind is never a lookup key.
 *
 * `SessionManager` keeps one driver per thread: the turn-scoped handle plus
 * the ingestion fiber draining its events into the log. A driver is removed
 * when its event stream ends (terminal events are guaranteed delivered) or
 * when the thread is deleted.
 */

import type { ConnectorInstanceId, ThreadId } from "@poseidon/contracts/ids";
import type {
  ConnectorError,
  ConnectorInstance,
  ResumeSessionInput,
  StartSessionInput,
} from "@poseidon/connector-sdk/definition";
import { ConnectorNotFound } from "@poseidon/connector-sdk/definition";
import type { ConnectorRegistry } from "@poseidon/connector-sdk/registry";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import {
  makeTurnScopedHandle,
  type TurnScopedSessionHandle,
} from "@poseidon/connector-sdk/turnScopedHandle";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { EngineEnv, OrchestrationEngine } from "./Engine";
import { forkOf, pendingImportResume, pendingNativeFork, sourceStillAt } from "./nativeFork";
import { ingestSession, type SessionLifecycle } from "./RuntimeIngestion";
import type { ThreadDoc } from "./state";

// ── Connector selection ───────────────────────────────────────

/** No connector instance is registered to run a thread on. */
export class NoConnector extends Data.TaggedError("NoConnector")<{
  readonly threadId: ThreadId;
}> {}

export class ConnectorSelection extends Context.Service<
  ConnectorSelection,
  {
    readonly instanceFor: (
      doc: ThreadDoc,
    ) => Effect.Effect<ConnectorInstance, ConnectorError | NoConnector>;
    readonly instanceById: (
      instanceId: ConnectorInstanceId,
    ) => Effect.Effect<ConnectorInstance, ConnectorNotFound>;
  }
>()("server/orchestration/ConnectorSelection") {
  /**
   * Over the live registry. A new thread goes to the instance it chose
   * (`settings.connectorInstanceId`) when that one is open. Otherwise — no
   * choice, or the chosen instance was disabled or removed since — it falls
   * back to the default rule: the first instance in `preference` that is open,
   * and the registry's own first entry when none of them is.
   *
   * `preference` is what keeps routing off an insertion accident: the registry
   * lists instances in the order `open` was called, and the connector manager
   * only reopens entries whose signature changed, so disabling and re-enabling
   * a connector moves it to the end. The entrypoint passes the enabled
   * connectors in settings-document order, with those whose probe says they
   * cannot run moved behind the rest — the same reading the engine seeds a new
   * thread's model from, so the two cannot name different instances. Tests
   * that wire a single connector pass nothing and get the registry's order.
   */
  static readonly fromRegistry = (
    registry: ConnectorRegistry,
    preference: Effect.Effect<ReadonlyArray<ConnectorInstanceId>> = Effect.succeed([]),
  ): Layer.Layer<ConnectorSelection> =>
    Layer.succeed(ConnectorSelection, {
      instanceFor: (doc) =>
        Effect.flatMap(registry.instances, (instances) =>
          Effect.flatMap(preference, (preferred) => {
            const open = (instanceId: ConnectorInstanceId | undefined) =>
              instanceId === undefined
                ? undefined
                : instances.find((instance) => instance.instanceId === instanceId);
            const chosen =
              open(doc.settings.connectorInstanceId) ??
              preferred.map(open).find((instance) => instance !== undefined) ??
              instances[0];
            return chosen === undefined
              ? Effect.fail(new NoConnector({ threadId: doc.threadId }))
              : Effect.succeed(chosen);
          }),
        ),
      instanceById: (instanceId) => registry.instance(instanceId),
    });

  /**
   * A fixed instance — what the orchestration tests and a single-connector
   * build want.
   */
  static readonly fromInstance = (instance: ConnectorInstance): Layer.Layer<ConnectorSelection> =>
    Layer.succeed(ConnectorSelection, {
      instanceFor: () => Effect.succeed(instance),
      instanceById: (instanceId) =>
        instanceId === instance.instanceId
          ? Effect.succeed(instance)
          : Effect.fail(new ConnectorNotFound({ instanceId, kind: instance.kind })),
    });
}

// ── Session drivers ───────────────────────────────────────────

interface SessionDriver {
  readonly handle: TurnScopedSessionHandle;
  readonly scope: Scope.Closeable;
  /**
   * False once the ingestion fiber ended — the map entry can outlive the
   * session by a scheduling step, and a dead handle must not be handed out.
   */
  readonly alive: Ref.Ref<boolean>;
  /** The fiber draining `handle.events` into the log; `close` awaits it. */
  readonly fiber: Fiber.Fiber<void, unknown>;
}

export class SessionManager extends Context.Service<
  SessionManager,
  {
    /** The thread's live handle, if a session is running. */
    readonly handleFor: (threadId: ThreadId) => Effect.Effect<TurnScopedSessionHandle | null>;
    /**
     * Starts or resumes the thread's session: `resumeSession` when the document
     * carries a bound `sessionRef`, `startSession` otherwise.
     */
    readonly ensure: (
      doc: ThreadDoc,
      projectWorkspaceRoot: string,
    ) => Effect.Effect<TurnScopedSessionHandle, ConnectorError | ConnectorNotFound | NoConnector>;
    /**
     * True when the thread's session is the harness's own fork of its
     * source's, or the imported session resumed (`nativeFork.ts`): it holds
     * the conversation already, so the first message goes without the
     * transcript. Known for sessions this process started.
     */
    readonly forkedNatively: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Closes and deregisters the thread's session, if one is running. */
    readonly close: (threadId: ThreadId) => Effect.Effect<void>;
    /** Session start/end reports — the supervisor's input. */
    readonly lifecycle: Stream.Stream<SessionLifecycle>;
  }
>()("server/orchestration/SessionManager") {
  static readonly layer = Layer.effect(
    SessionManager,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      const selection = yield* ConnectorSelection;
      const drivers = yield* Ref.make<ReadonlyMap<ThreadId, SessionDriver>>(new Map());
      const lifecycle = yield* PubSub.unbounded<SessionLifecycle>();
      const nativeForks = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
      // One attach at a time: a raced ensure() must not spawn two sessions.
      const attachMutex = yield* Semaphore.make(1);

      const report = (entry: SessionLifecycle) => PubSub.publish(lifecycle, entry);

      /**
       * `resumeSession` on one instance in a scope of its own, or `null` when
       * it fails (logged as `what`): the caller then starts a fresh session.
       */
      const resumeOwn = (
        instanceId: ConnectorInstanceId,
        input: ResumeSessionInput,
        what: string,
      ) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          return yield* selection.instanceById(instanceId).pipe(
            Effect.flatMap((instance) =>
              instance.resumeSession(input).pipe(
                Scope.provide(scope),
                Effect.map((raw) => ({ instance, raw, scope })),
              ),
            ),
            Effect.catch((error) =>
              Scope.close(scope, Exit.succeed(undefined)).pipe(
                Effect.andThen(Effect.logWarning(`could not ${what}; starting fresh`, error)),
                Effect.as(null),
              ),
            ),
          );
        });

      /**
       * A fork's first session, forked by the harness from its source's
       * (`pendingNativeFork`), in a scope of its own. `null` when the thread
       * is not one, when the source has run on since the fork was made
       * (`sourceStillAt`), and when the fork fails — the source's instance is
       * gone, or the harness no longer has the session — so the caller starts
       * a fresh session and the fork's transcript goes out with its first
       * message instead.
       */
      const forkNatively = (doc: ThreadDoc, input: StartSessionInput) =>
        Effect.gen(function* () {
          const source = pendingNativeFork(doc);
          const sourceId = forkOf(doc)?.threadId;
          if (source === null || sourceId === undefined) {
            return null;
          }
          const sourceDoc = yield* engine
            .threadDoc(sourceId)
            .pipe(Effect.catch((error) => Effect.logWarning("fork source read failed", error)));
          if (!sourceStillAt(source, sourceDoc ?? null)) {
            return null;
          }
          const forked = yield* resumeOwn(
            source.connectorInstanceId,
            { ...input, sessionRef: source.sessionRef, fork: true },
            "fork the source session",
          );
          return forked === null ? null : { ...forked, native: true };
        });

      /**
       * An imported thread's first session: the harness's own session, resumed
       * by its reference (`pendingImportResume`), in a scope of its own.
       * `null` when there is none to resume and when the resume fails — the
       * instance is gone, or the harness refused — so the caller starts a
       * fresh session and the imported rows go out as a transcript with the
       * first message instead.
       *
       * A connector that no longer finds the conversation may start afresh on
       * its own and succeed. Its session then names another session than the
       * import's (`sourceIdOf`), and is kept but not counted as holding the
       * conversation, so the transcript still goes out.
       */
      const resumeImported = (doc: ThreadDoc, input: StartSessionInput) =>
        Effect.gen(function* () {
          const session = pendingImportResume(doc);
          const sourceId = doc.imported?.sourceId;
          if (session === null || sourceId === undefined) {
            return null;
          }
          const resumed = yield* resumeOwn(
            session.connectorInstanceId,
            { ...input, sessionRef: session.sessionRef },
            "resume the imported session",
          );
          if (resumed === null) {
            return null;
          }
          const sourceIdOf = resumed.instance.extensions?.sessions?.sourceIdOf;
          const ref = yield* resumed.raw.sessionRef().pipe(Effect.orElseSucceed(() => undefined));
          const native = sourceIdOf === undefined || sourceIdOf(ref) === sourceId;
          return { ...resumed, native };
        });

      const attach = (
        doc: ThreadDoc,
        workspaceRoot: string,
      ): Effect.Effect<TurnScopedSessionHandle, ConnectorError | ConnectorNotFound | NoConnector> =>
        attachMutex.withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* Ref.get(drivers);
            const running = existing.get(doc.threadId);
            if (running !== undefined && (yield* Ref.get(running.alive))) {
              return running.handle;
            }
            const input = {
              threadId: doc.threadId,
              projectId: doc.projectId,
              workspaceRoot,
              settings: doc.settings,
            };
            // A harness session that may hold the conversation already: a
            // native fork, or the imported session resumed (`native` says).
            const continued =
              (yield* forkNatively(doc, input)) ?? (yield* resumeImported(doc, input));
            const driverScope = continued?.scope ?? (yield* Scope.make());
            const instance =
              continued?.instance ??
              (doc.session === null
                ? yield* selection.instanceFor(doc)
                : yield* selection.instanceById(doc.session.connectorInstanceId));
            const raw: SessionHandle =
              continued?.raw ??
              (yield* (
                doc.session === null
                  ? instance.startSession(input)
                  : instance.resumeSession({ ...input, sessionRef: doc.session.sessionRef })
              ).pipe(Scope.provide(driverScope)));
            if (doc.session === null) {
              yield* Ref.update(nativeForks, (all) => {
                const next = new Set(all);
                if (continued?.native === true) next.add(doc.threadId);
                else next.delete(doc.threadId);
                return next;
              });
            }
            const handle = yield* makeTurnScopedHandle(raw, {
              connectorInstanceId: instance.instanceId,
              threadId: doc.threadId,
            });

            const alive = yield* Ref.make(true);
            const engineEnv = yield* EngineEnv;
            // `ended` is buffered, not reported: the lifecycle channel only
            // sees it after the driver is deregistered, so a supervisor that
            // reacts to `crashed` never observes a still-registered corpse.
            const ended = yield* Ref.make<SessionLifecycle | null>(null);
            const ingest = ingestSession(
              handle,
              {
                threadId: doc.threadId,
                connectorInstanceId: instance.instanceId,
                connectorKind: instance.kind,
              },
              {
                nextEventId: engineEnv.nextEventId,
                append: (threadId, events) =>
                  engine
                    .appendThreadEvents(threadId, events)
                    .pipe(
                      Effect.catch((error) => Effect.logWarning("ingest append failed", error)),
                    ),
                report: (entry) => (entry.kind === "ended" ? Ref.set(ended, entry) : report(entry)),
              },
            ).pipe(
              // The event stream ends only after the session's terminal events,
              // so an ending ingestion fiber means the driver is dead.
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Ref.set(alive, false);
                  yield* Ref.update(drivers, (all) => {
                    const next = new Map(all);
                    next.delete(doc.threadId);
                    return next;
                  });
                  yield* Scope.close(driverScope, Exit.succeed(undefined));
                  const entry = yield* Ref.get(ended);
                  // A stream that ends without `session.ended` is a crash —
                  // the process is gone either way.
                  yield* report(
                    entry ?? {
                      kind: "ended",
                      threadId: doc.threadId,
                      connectorInstanceId: instance.instanceId,
                      reason: "crashed",
                    },
                  );
                }),
              ),
            );
            const fiber = yield* Effect.forkIn(ingest, driverScope);

            yield* Ref.update(drivers, (all) =>
              new Map(all).set(doc.threadId, { handle, scope: driverScope, alive, fiber }),
            );
            yield* report({
              kind: "started",
              threadId: doc.threadId,
              connectorInstanceId: instance.instanceId,
            });
            return handle;
          }),
        );

      /** Stops one session: the handle first, then its drain, then its scope. */
      const closeSession = (threadId: ThreadId): Effect.Effect<void> =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const all = yield* Ref.get(drivers);
            const driver = all.get(threadId);
            if (driver === undefined) {
              return;
            }
            yield* Ref.set(driver.alive, false);
            yield* Ref.update(drivers, (map) => {
              const next = new Map(map);
              next.delete(threadId);
              return next;
            });
            // Close the handle first so the connector emits `session.ended`,
            // then wait for the ingestion fiber to drain it — its `ensuring`
            // reports the real reason. Closing the scope first would
            // interrupt the drain mid-flight and report `crashed`, and the
            // supervisor would resurrect a session we deliberately stopped.
            yield* driver.handle
              .close()
              .pipe(Effect.catch((error) => Effect.logWarning("session close failed", error)));
            yield* Fiber.await(driver.fiber).pipe(
              Effect.timeoutOrElse({
                // A connector that keeps its event stream open after close
                // must not wedge the caller — the scope close below cuts the
                // drain off and reports `crashed`, which is what an undead
                // stream genuinely means.
                duration: Duration.seconds(5),
                orElse: () =>
                  Effect.logWarning("session event stream outlived close; interrupting it"),
              }),
            );
            yield* Scope.close(driver.scope, Exit.succeed(undefined));
          }),
        );

      /**
       * Every open session goes down with the manager.
       *
       * A session's driver scope is free-standing — `Scope.make()`, not a
       * child of this layer's — because a session outlives the command that
       * started it and is closed by `close(threadId)`. Nothing closed the ones
       * still open when the server itself stopped, so their finalizers never
       * ran: the child process was left behind, and so were the two files the
       * connector puts in the user's Command Code config. An `poseidon` MCP
       * entry naming a port nothing is listening on is worse than none, and it
       * accumulated one per session, forever.
       */
      yield* Effect.addFinalizer(() =>
        Ref.get(drivers).pipe(
          Effect.flatMap((all) =>
            Effect.forEach(all.keys(), (threadId) => closeSession(threadId), { discard: true }),
          ),
        ),
      );

      return SessionManager.of({
        handleFor: (threadId) =>
          Effect.gen(function* () {
            const driver = (yield* Ref.get(drivers)).get(threadId);
            if (driver === undefined || !(yield* Ref.get(driver.alive))) {
              return null;
            }
            return driver.handle;
          }),
        ensure: (doc, projectWorkspaceRoot) => attach(doc, projectWorkspaceRoot),
        forkedNatively: (threadId) =>
          Ref.get(nativeForks).pipe(Effect.map((all) => all.has(threadId))),
        close: closeSession,
        lifecycle: Stream.fromPubSub(lifecycle),
      });
    }),
  );
}
