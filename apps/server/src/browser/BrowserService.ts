/**
 * The real `BrowserService` behind the RPC tag in `../rpc/services` —
 * session registry, the serialized per-thread command queue, the
 * human-control epoch and the teardown reactor.
 *
 * The service runs in one mode for its whole life, fixed by what the desktop
 * shell handed over (see `./agentBrowser`):
 *
 * - `in-app` — the agent drives the thread's own pane webviews through the
 *   shell's browser bridge (`./inAppDriver`). The pane moves its webview
 *   itself; the server never navigates it for the human.
 * - `owned-chromium` — no desktop: agent-browser's own headless Chrome, with
 *   the pane showing its frame stream and the toolbar driving it through
 *   the server (`./ownedDriver`).
 * - `disabled` — the shell ran with `POSEIDON_REMOTE_DEBUG=0`: every call
 *   answers that, and nothing is opened.
 *
 * There is no fallback between them. A desktop attach that fails is an error
 * the agent and the pane both see.
 *
 * A session is a lazy record: `browser.subscribe` creates the state ref but
 * not the browser. The driver is opened on the first agent call (or, in
 * owned mode, the first toolbar navigation), so opening the pane never starts
 * a browser.
 *
 * The interrupt rule: every session carries an epoch that every human gesture
 * bumps. A call that settles under a different epoch than it started returns
 * `interrupted_by_human`; the harness sees that string in the tool result.
 * Input the agent synthesizes over CDP is never relayed back as a gesture, so
 * nothing the agent does can count as the human.
 *
 * Teardown runs on `thread.deleted`/`thread.archived` — the only writer of
 * durable thread state is the engine, so this service listens for its events
 * rather than being called by the session manager. It waits its turn in the
 * session's queue, so an in-flight call finishes first; then it closes the
 * driver and publishes a final `stopped` state. Token revocation is the MCP
 * gateway's job.
 *
 * No agent-browser daemon outlives what started it:
 *
 * - At build, `reap` closes whatever a crashed or killed run left in our
 *   namespace; the first driver waits for it.
 * - Closing the service's scope — the server shutting down — closes every
 *   driver at once, bounded to fit inside the desktop's SIGINT→SIGKILL grace.
 * - A command that times out closes its driver (the driver's close kills a
 *   daemon that will not answer); the next call opens a fresh one.
 */

import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ThreadId } from "@poseidon/contracts/ids";
import { makeRequestId } from "@poseidon/contracts/ids";
import type { BrowserFrame, BrowserHumanInput, BrowserState } from "@poseidon/contracts/rpc";

import { OrchestrationEngine } from "../orchestration/Engine";
import { PermissionService } from "../permissions/PermissionService";
import { BrowserService } from "../rpc/services";
import { AgentBrowser, BROWSER_DISABLED_MESSAGE, isTimeout } from "./agentBrowser";
import type { BrowserDriver, DriverEvents } from "./driver";
import { openInAppDriver } from "./inAppDriver";
import { openOwnedDriver } from "./ownedDriver";
import { findBrowserTool, type BrowserCallOutcome, type PreparedCall } from "./tools";

const STOPPED_STATUS = "stopped" as const;

/**
 * How long shutdown gives every driver together to close. The desktop sends
 * the server SIGINT and SIGKILLs it 5s later; a driver's close is itself
 * bounded (`close`, then a kill), so this is the backstop inside that grace.
 */
const SHUTDOWN_TIMEOUT_MS = 4_000;

/** What a call waiting in a closed thread's queue answers. */
const CLOSED_MESSAGE = "the thread's browser was closed";

type BrowserMode = BrowserState["mode"];

/** An open driver plus the scope its stream/fibers live under. */
interface OpenDriver {
  readonly driver: BrowserDriver;
  readonly scope: Scope.Closeable;
}

interface Session {
  readonly threadId: ThreadId;
  readonly state: SubscriptionRef.SubscriptionRef<BrowserState>;
  readonly epoch: Ref.Ref<number>;
  readonly queue: Semaphore.Semaphore;
  /** Set by teardown and shutdown: nothing opens a driver for it again. */
  readonly closed: Ref.Ref<boolean>;
  readonly driver: Ref.Ref<OpenDriver | null>;
}

/** Gestures that are a person at the page: all of them but passive `location`. */
const isGesture = (input: BrowserHumanInput): boolean => input.kind !== "location";

const initialState = (threadId: ThreadId, mode: BrowserMode): BrowserState => ({
  threadId,
  status: STOPPED_STATUS,
  mode,
  url: null,
  title: null,
  frame: null,
  ...(mode === "disabled" ? { message: BROWSER_DISABLED_MESSAGE } : {}),
});

/** What the driver seam needs at open time (one per thread). */
export interface OpenDriverOptions {
  readonly threadId: ThreadId;
  readonly events: DriverEvents;
}

/**
 * The service body, with the driver opener injected so tests can run the
 * whole queue/epoch/teardown path against `makeFakeDriver` without touching a
 * real `agent-browser` binary. `mode` is the server's one mode; in `disabled`
 * the opener is never called.
 */
export const makeService = (injected: {
  readonly mode: BrowserMode;
  readonly openDriver: (
    options: OpenDriverOptions,
  ) => Effect.Effect<BrowserDriver, { readonly message: string }, Scope.Scope>;
  /** Closes what an earlier run left behind; the first driver waits for it. */
  readonly reap?: Effect.Effect<void>;
  /** Whether `agent-browser --version` answered at startup, and what it printed. */
  readonly cli?: { readonly installed: boolean; readonly version: string | null };
}): Effect.Effect<
  BrowserService["Service"],
  never,
  OrchestrationEngine | PermissionService | Scope.Scope
> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const permissions = yield* PermissionService;
    const serviceScope = yield* Effect.scope;
    const mode = injected.mode;

    const sessions = yield* Ref.make(new Map<ThreadId, Session>());
    /**
     * Each thread's state ref, kept apart from its session: `browser.subscribe`
     * binds a client to the ref, and teardown drops the session on archive, so
     * a pane still open when the thread comes back would otherwise watch a ref
     * nothing writes to again. The session made after an unarchive reuses it;
     * only a deleted thread's is forgotten.
     */
    const states = yield* Ref.make(
      new Map<ThreadId, SubscriptionRef.SubscriptionRef<BrowserState>>(),
    );

    // The boot reap runs beside the rest of the build rather than holding it
    // up; a driver opened before it finished would be closed by it.
    const reaped = yield* Deferred.make<void>();
    yield* Effect.forkIn(
      (injected.reap ?? Effect.void).pipe(Effect.ensuring(Deferred.succeed(reaped, undefined))),
      serviceScope,
    );
    // Serializes session-record creation across threads of the map.
    const registryLock = yield* Semaphore.make(1);

    const getSession = (threadId: ThreadId): Effect.Effect<Session> =>
      registryLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = (yield* Ref.get(sessions)).get(threadId);
          if (existing !== undefined) return existing;
          let state = (yield* Ref.get(states)).get(threadId);
          if (state === undefined) {
            const made = yield* SubscriptionRef.make(initialState(threadId, mode));
            yield* Ref.update(states, (map) => new Map(map).set(threadId, made));
            state = made;
          }
          const session: Session = {
            threadId,
            state,
            epoch: yield* Ref.make(0),
            queue: yield* Semaphore.make(1),
            closed: yield* Ref.make(false),
            driver: yield* Ref.make<OpenDriver | null>(null),
          };
          yield* Ref.update(sessions, (map) => new Map(map).set(threadId, session));
          return session;
        }),
      );

    /**
     * The owned-mode stream ended: the daemon reaped itself after its idle
     * timeout, or crashed. The driver's stream is dead with it and a new
     * daemon would start on about:blank, so the driver is dropped — without
     * `close`, which would only start a daemon to close — and the next call or
     * toolbar navigation opens a fresh one with a stream of its own. Forked
     * onto the service scope, since the stream fiber reporting this lives in
     * the scope being closed; in the queue, so a call in flight finishes first.
     */
    const driverEnded = (session: Session, ended: OpenDriver): Effect.Effect<void> =>
      Effect.forkIn(
        session.queue.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(session.driver);
            if (current !== ended) return;
            yield* Ref.set(session.driver, null);
            yield* Scope.close(ended.scope, Exit.void);
            yield* SubscriptionRef.update(session.state, (state) => ({
              ...state,
              status: STOPPED_STATUS,
              frame: null,
              url: null,
              title: null,
            }));
          }),
        ),
        serviceScope,
      ).pipe(Effect.asVoid);

    /** `opened` is the driver these events belong to, once it is open. */
    const eventsFor = (session: Session, opened: { current: OpenDriver | null }): DriverEvents => ({
      onFrame: (frame: BrowserFrame) =>
        SubscriptionRef.update(session.state, (state) => ({ ...state, frame })),
      onUrl: (url: string) => SubscriptionRef.update(session.state, (state) => ({ ...state, url })),
      onEnded: () =>
        Effect.andThen(
          SubscriptionRef.update(session.state, (state) => ({ ...state, frame: null })),
          Effect.suspend(() =>
            opened.current === null ? Effect.void : driverEnded(session, opened.current),
          ),
        ),
    });

    const ensureDriver = (session: Session): Effect.Effect<BrowserDriver, BrowserCallOutcome> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(session.driver);
        if (current !== null) return current.driver;
        // A call that queued behind teardown must not open a driver nobody
        // will close.
        if (yield* Ref.get(session.closed)) {
          return yield* Effect.fail<BrowserCallOutcome>({ kind: "error", message: CLOSED_MESSAGE });
        }
        yield* Deferred.await(reaped);

        yield* SubscriptionRef.update(session.state, (state) => ({
          ...state,
          status: "starting" as const,
          message: undefined,
        }));

        // `provide`, not `use`: the driver outlives its open. `use` closes the
        // scope as soon as the effect settles, which would interrupt the frame
        // stream fiber the owned driver forks into it — releaseDriver is what
        // closes this scope, when the session is really done with the driver.
        const scope = yield* Scope.make();
        const entry: { current: OpenDriver | null } = { current: null };
        const opened = yield* Scope.provide(scope)(
          injected.openDriver({ threadId: session.threadId, events: eventsFor(session, entry) }),
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Scope.close(scope, Exit.void);
              yield* SubscriptionRef.update(session.state, (state) => ({
                ...state,
                status: "error" as const,
                message: error.message,
              }));
              return yield* Effect.fail<BrowserCallOutcome>({
                kind: "error",
                message: error.message,
              });
            }),
          ),
        );

        entry.current = { driver: opened, scope };
        yield* Ref.set(session.driver, entry.current);
        yield* SubscriptionRef.update(session.state, (state) => ({
          ...state,
          status: "ready" as const,
        }));
        return opened;
      });

    const releaseDriver = (session: Session): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.getAndSet(session.driver, null);
        if (current !== null) {
          yield* current.driver.close;
          yield* Scope.close(current.scope, Exit.void);
        }
      });

    /** Re-read url/title after calls that can move the page. */
    const refreshLocation = (session: Session, driver: BrowserDriver): Effect.Effect<void> =>
      driver.location.pipe(
        Effect.flatMap(({ url, title }) =>
          SubscriptionRef.update(session.state, (state) => ({
            ...state,
            url: url ?? state.url,
            title: title ?? state.title,
          })),
        ),
        Effect.ignore,
      );

    /**
     * An owned-mode address-bar navigation: mirror the url immediately so the
     * toolbar stops fighting the field, then move the page and re-read where
     * it actually landed.
     */
    const navigateWith = (
      session: Session,
      driver: BrowserDriver,
      url: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(session.state, (state) => ({ ...state, url }));
        yield* driver.exec(["open", url]).pipe(Effect.ignore);
        yield* refreshLocation(session, driver);
      });

    /**
     * A call that runs the agent's JavaScript in the page (`browser_eval`, or
     * `browser_wait` on a condition) carries the `web` approval kind — denied
     * in plan mode and by deny rules.
     */
    const gateScript = (
      threadId: ThreadId,
      name: string,
      args: unknown,
    ): Effect.Effect<BrowserCallOutcome | null> =>
      Effect.gen(function* () {
        const doc = yield* engine.threadDoc(threadId).pipe(Effect.orElseSucceed(() => null));
        const decision = yield* permissions
          .decide({
            request: {
              requestId: makeRequestId(),
              kind: "web",
              toolName: `mcp__poseidon__${name}`,
              input: typeof args === "object" && args !== null ? args : {},
              description: "evaluate JavaScript in the thread's browser",
            },
            runtimeMode: doc?.settings.runtimeMode ?? "approval-required",
            interactionMode: doc?.settings.interactionMode ?? "default",
            threadId,
          })
          .pipe(Effect.orElseSucceed((): "prompt" => "prompt"));
        if (decision === "deny") {
          return {
            kind: "error",
            message: `${name} runs JavaScript in the page, which the thread's current permission mode denies`,
          };
        }
        // "prompt" reaches us after the harness-side PreToolUse approval, and
        // "allow" is a rule the user set — either way the call may run.
        return null;
      });

    const screenshotPath = () =>
      join(tmpdir(), `poseidon-shot-${Math.random().toString(16).slice(2)}.png`);

    const execOnce = (
      driver: BrowserDriver,
      argv: ReadonlyArray<string>,
      options?: { readonly timeoutMs: number },
    ) =>
      driver.exec(argv, options).pipe(
        Effect.map((data) => ({ ok: true as const, data })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );

    const runCall = (
      session: Session,
      call: PreparedCall,
    ): Effect.Effect<BrowserCallOutcome, never, never> =>
      session.queue.withPermits(1)(
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const epoch = yield* Ref.get(session.epoch);
            yield* SubscriptionRef.update(session.state, (state) => ({
              ...state,
              activeTool: call.name,
            }));
            return epoch;
          }),
          (epoch) =>
            Effect.gen(function* () {
              const ensured = yield* ensureDriver(session).pipe(
                Effect.map((driver) => ({ ok: true as const, driver })),
                Effect.catch((outcome) => Effect.succeed({ ok: false as const, outcome })),
              );
              if (!ensured.ok) return ensured.outcome;
              const driver = ensured.driver;
              const argv = call.screenshot
                ? call.argv.map((part) => (part === "{shot}" ? screenshotPath() : part))
                : call.argv;
              // A `tab_gone` comes back as an error like any other: the in-app
              // driver has already dropped the dead binding, so the agent's
              // next call attaches to the pane's current tab.
              const executed = yield* execOnce(
                driver,
                argv,
                call.timeoutMs === undefined ? undefined : { timeoutMs: call.timeoutMs },
              );
              if (!executed.ok) {
                if (!isTimeout(executed.error)) {
                  return {
                    kind: "error",
                    message: executed.error.message,
                  } satisfies BrowserCallOutcome;
                }
                // A daemon stuck on one command is stuck for the next one too.
                // Close it (a kill if it will not close); the next call opens
                // a fresh one.
                const message = call.timeoutMessage ?? executed.error.message;
                yield* releaseDriver(session);
                yield* SubscriptionRef.update(session.state, (state) => ({
                  ...state,
                  status: "error" as const,
                  message,
                }));
                return { kind: "error", message } satisfies BrowserCallOutcome;
              }
              const data = executed.data;

              if (call.mutating) yield* refreshLocation(session, driver);

              const epochAfter = yield* Ref.get(session.epoch);
              if (epochAfter !== epoch) {
                return { kind: "interrupted", status: "interrupted_by_human" } as const;
              }

              let image: { data: string; mediaType: string } | undefined;
              if (call.screenshot && typeof data.path === "string") {
                const bytes = yield* Effect.promise(() => readFile(String(data.path))).pipe(
                  Effect.option,
                );
                if (Option.isSome(bytes)) {
                  image = { data: bytes.value.toString("base64"), mediaType: "image/png" };
                  yield* Effect.promise(() => unlink(String(data.path))).pipe(Effect.ignore);
                }
              }
              return { kind: "ok", data, ...(image === undefined ? {} : { image }) } as const;
            }),
          () => SubscriptionRef.update(session.state, (state) => ({ ...state, activeTool: null })),
        ),
      );

    const callTool = (
      threadId: ThreadId,
      name: string,
      args: unknown,
    ): Effect.Effect<BrowserCallOutcome> =>
      Effect.gen(function* () {
        const spec = findBrowserTool(name);
        if (spec === undefined) {
          return {
            kind: "error",
            message: `unknown browser tool: ${name}`,
          } satisfies BrowserCallOutcome;
        }
        const prepared = spec.prepare(args);
        if (!prepared.ok) {
          return { kind: "error", message: prepared.error } satisfies BrowserCallOutcome;
        }
        if (mode === "disabled") {
          return { kind: "error", message: BROWSER_DISABLED_MESSAGE } satisfies BrowserCallOutcome;
        }
        if (prepared.call.script) {
          const denied = yield* gateScript(threadId, name, args);
          if (denied !== null) return denied;
        }
        const session = yield* getSession(threadId);
        return yield* runCall(session, prepared.call);
      });

    const humanInput = (threadId: ThreadId, input: BrowserHumanInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const session = yield* getSession(threadId);

        if (input.kind === "location") {
          yield* SubscriptionRef.update(session.state, (state) => ({
            ...state,
            url: input.url,
            title: input.title ?? state.title,
          }));
          return;
        }

        // Human control: any gesture bumps the epoch, so an agent call in
        // flight settles as `interrupted_by_human`.
        if (isGesture(input)) {
          yield* Ref.update(session.epoch, (epoch) => epoch + 1);
        }

        if (mode !== "owned-chromium") {
          // In-app, the pane moves its own webview — the gesture already
          // happened in the guest, and the toolbar navigates it directly. All
          // the server does is mirror a navigation's url. It never runs
          // agent-browser for the human: `reload` over CDP reloads the whole
          // Poseidon window, not the tab.
          if (input.kind === "navigate") {
            yield* SubscriptionRef.update(session.state, (state) => ({ ...state, url: input.url }));
          }
          // The pane's Retry on a failed attach. In-app an error always means
          // no driver (a failed open, or a timeout that released it), so this
          // only clears the pane's alert; the agent's next call attaches
          // afresh. It never starts agent-browser for the human.
          if (mode === "in-app" && input.kind === "history" && input.direction === "reload") {
            yield* SubscriptionRef.update(session.state, (state) =>
              state.status === "error"
                ? { ...state, status: STOPPED_STATUS, message: undefined }
                : state,
            );
          }
          return;
        }

        const current = yield* Ref.get(session.driver);
        if (current === null) {
          // No browser yet. A navigate is enough reason to start one, and so
          // is a reload — that is the pane's "try again" after a failed open.
          // Back and forward are not: there is no history to move through, and
          // starting a browser for them would pop a window and do nothing.
          if (
            input.kind === "navigate" ||
            (input.kind === "history" && input.direction === "reload")
          ) {
            yield* session.queue.withPermits(1)(
              Effect.gen(function* () {
                const ensured = yield* Effect.option(ensureDriver(session));
                if (Option.isSome(ensured) && input.kind === "navigate") {
                  yield* navigateWith(session, ensured.value, input.url);
                }
              }),
            );
          }
          return;
        }
        const driver = current.driver;

        // Owned Chromium has no page of its own in the pane — only frames — so
        // the toolbar and the gestures on the frame surface go through here.
        switch (input.kind) {
          case "click":
          case "key":
          case "text":
          case "scroll":
            yield* driver.sendInput(input).pipe(Effect.ignore);
            return;
          case "navigate":
            yield* session.queue.withPermits(1)(navigateWith(session, driver, input.url));
            return;
          case "history":
            // agent-browser has no stop; the gesture above was the point.
            if (input.direction === "stop") return;
            yield* session.queue.withPermits(1)(
              driver
                .exec(
                  input.direction === "back"
                    ? ["back"]
                    : input.direction === "forward"
                      ? ["forward"]
                      : ["reload"],
                )
                .pipe(Effect.ignore)
                .pipe(Effect.andThen(refreshLocation(session, driver))),
            );
            return;
          default:
            return;
        }
      });

    /** `forget`: the thread was deleted, so no pane will watch it again. */
    const teardown = (threadId: ThreadId, forget = false): Effect.Effect<void> =>
      Effect.gen(function* () {
        const session = (yield* Ref.get(sessions)).get(threadId);
        if (forget) {
          yield* Ref.update(states, (map) => {
            const next = new Map(map);
            next.delete(threadId);
            return next;
          });
        }
        if (session === undefined) return;
        // In the queue: a call in flight finishes before its driver closes,
        // and whatever queued behind this finds the session closed.
        yield* session.queue.withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.set(session.closed, true);
            yield* releaseDriver(session);
          }),
        );
        yield* SubscriptionRef.set(session.state, {
          ...initialState(session.threadId, mode),
          status: STOPPED_STATUS,
        });
        yield* Ref.update(sessions, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
      }).pipe(Effect.ignore);

    // Shutdown closes every driver at once and waits for no queue: a call in
    // flight is being interrupted with the rest of the server.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const open = [...(yield* Ref.get(sessions)).values()];
        yield* Effect.forEach(
          open,
          (session) => Effect.andThen(Ref.set(session.closed, true), releaseDriver(session)),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.timeout(SHUTDOWN_TIMEOUT_MS), Effect.ignore),
    );

    // Thread close tears the browser down — deleted or archived.
    //
    // The subscription is opened here rather than inside the forked fiber: a
    // PubSub drops what it publishes while nobody is listening, and a forked
    // fiber does not start until this one yields. Subscribing first means no
    // thread.deleted can slip through the gap between build and first tick.
    //
    // Its lifetime is the consumer's, not the service's: the PubSub is
    // unbounded, so a subscription nobody drains retains every event forever.
    // The reactor's own scope closes it whether it ends or is interrupted.
    const reactorScope = yield* Scope.make();
    const events = yield* Scope.provide(reactorScope)(engine.subscribeEvents);
    const reactor = Stream.runForEach(Stream.fromSubscription(events), (event) =>
      event.type === "thread.deleted" || event.type === "thread.archived"
        ? teardown(event.streamId as ThreadId, event.type === "thread.deleted")
        : Effect.void,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser teardown reactor ended", error)),
      Effect.ensuring(Scope.close(reactorScope, Exit.void)),
    );
    yield* Effect.forkIn(reactor, serviceScope);

    return BrowserService.of({
      subscribe: (threadId) =>
        Stream.unwrap(
          Effect.map(getSession(threadId), (session) => SubscriptionRef.changes(session.state)),
        ),
      humanInput,
      callTool,
      teardown: (threadId) => teardown(threadId),
      status: {
        mode,
        installed: injected.cli?.installed ?? false,
        version: injected.cli?.version || null,
      },
    });
  });

export const layer: Layer.Layer<
  BrowserService,
  never,
  OrchestrationEngine | PermissionService | AgentBrowser
> = Layer.effect(
  BrowserService,
  Effect.gen(function* () {
    const agentBrowser = yield* AgentBrowser;
    return yield* makeService({
      mode: agentBrowser.mode,
      openDriver: ({ threadId, events }) => {
        const session = agentBrowser.session(threadId);
        const opened =
          agentBrowser.mode === "in-app"
            ? openInAppDriver(session)
            : openOwnedDriver(session, events);
        // An open that failed part-way may have started the daemon.
        return opened.pipe(Effect.tapError(() => session.shutdown));
      },
      reap: agentBrowser.reap,
      cli: { installed: agentBrowser.binary !== null, version: agentBrowser.version },
    });
  }),
);
