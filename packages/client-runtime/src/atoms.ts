/**
 * The atom layer of the client runtime. `makeRuntime(connectionLayer)` builds
 * an `AtomRuntime` over the connection, then each factory answers one piece of
 * UI state:
 *
 * - `threadDetailAtom(threadId)` — live thread view; reconnects resume with
 *   `afterSequence`, `resnapshot-required` restarts from scratch, and a changed
 *   `serverInstanceId` discards the cached snapshot entirely.
 * - `threadListAtom(projectId)` — the sidebar list.
 * - `projectsAtom`, `connectorsAtom`, `settingsAtom` — read models.
 * - `connectorDescriptorsAtom` — every connector the server ships, with the
 *   metadata and config form the connectors page renders.
 * - `modelCatalogAtom` — every enabled instance with its models, for the
 *   pickers (`./connectorAtoms`).
 * - `connectionStateAtom` — the reconnecting banner's source.
 * - `dispatchAtom` — sends a `Command` and resolves with its receipt.
 * - `stageAttachmentAtom` / `attachmentAtom` — upload a composer image, and
 *   read a staged one back for a thumbnail. The bytes never ride a command.
 */

import type { ConnectorInstanceId, ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type {
  ThreadSummary,
  Command,
  ThreadListStreamItem,
  ThreadStreamItem,
} from "@poseidon/contracts/orchestration";
import type {
  ConnectorDescriptor,
  ConnectorSummary,
  ModelOption,
  PluginSummary,
  SkillSummary,
} from "@poseidon/contracts/connectors";
import type {
  AttachmentBytes,
  BrowserHumanInput,
  BrowserState,
  FileSearchResult,
  HarnessCommand,
} from "@poseidon/contracts/rpc";
import type { Keybinding, Settings } from "@poseidon/contracts/settings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import { PROTOCOL_VERSION, type PoseidonRpcError } from "@poseidon/contracts/rpc";

import { Connection, ConnectionStateRef, markConnected, markIncompatible } from "./connection";
import { applyThreadListItem, applyThreadStreamItem, type ThreadDetailView } from "./clientState";
import { makeConnectorAtoms } from "./connectorAtoms";

export interface ConnectionLayer extends Layer.Layer<
  Connection | ConnectionStateRef,
  never,
  Scope.Scope
> {}

/**
 * Retries a subscription until it holds: while the socket is down each attempt
 * fails fast, the protocol's own reconnect runs underneath, and the next try
 * lands on the fresh socket. Jitter keeps every subscriber from resubscribing
 * in the same tick.
 */
const resubscribeSchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay((meta) => Effect.succeed(Duration.min(meta.duration, Duration.seconds(2)))),
);

/**
 * The same schedule, but only for failures worth retrying.
 *
 * A dropped socket is a hiccup: the next attempt lands on the fresh one. An
 * `PoseidonRpcError` is the server's considered answer — a bad row in a read
 * model, a half-applied migration — and retrying it forever only hammers a
 * server that has already said no, while the atom sits on its `initialValue`
 * with nothing to tell the page apart from "there is nothing here". Failing
 * the schedule with that same error stops the loop and hands the error to the
 * atom, where it renders as an `AsyncResult` failure.
 */
export const transportOnly = <E>(): Schedule.Schedule<Duration.Duration, E, E> =>
  resubscribeSchedule.pipe(
    Schedule.setInputType<E>(),
    Schedule.tap((meta) =>
      Predicate.isTagged(meta.input, "PoseidonRpcError") ? Effect.fail(meta.input) : Effect.void,
    ),
  );

/**
 * `hello → subscribe` as one resumable loop. The hello doubles as the
 * instance-id check; a changed id resets `afterSequence` and clears the atom's
 * snapshot so stale projections can't survive a server restart.
 *
 * `retry` covers failures (socket down, RPC error); `repeat` covers the clean
 * end the server sends after `resnapshot-required` — `retry` alone would leave
 * the atom silent until remount.
 */
const threadStream = (
  threadId: ThreadId,
  state: Ref.Ref<ThreadDetailView | null>,
): Stream.Stream<
  ThreadStreamItem,
  PoseidonRpcError | RpcClientError.RpcClientError,
  Connection | ConnectionStateRef
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connection = yield* Connection;
      const client = yield* connection.client;
      const connectionState = yield* ConnectionStateRef;
      const hello = yield* client["server.hello"]({});
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        yield* markIncompatible;
        return Stream.never;
      }
      const doc = yield* Ref.get(state);
      const known = yield* SubscriptionRef.get(connectionState);
      const afterSequence =
        doc === null || known.serverInstanceId !== hello.serverInstanceId
          ? undefined
          : doc.snapshotSequence;
      if (afterSequence === undefined) {
        yield* Ref.set(state, null);
      }
      yield* markConnected(hello.serverInstanceId);
      return client["threads.subscribe"]({ threadId, afterSequence });
    }),
  ).pipe(Stream.retry(transportOnly()), Stream.repeat(resubscribeSchedule));

/**
 * The sidebar list's equivalent loop. Only the `snapshot` frame carries a
 * sequence, so that is the resume point a reconnect asks from; the catch-up
 * frames the server replays are absolute (`upserted` replaces, `removed`
 * filters), which makes replaying the same span twice harmless. A span that
 * has grown past the server's budget comes back as `resnapshot-required`,
 * which drops the resume point and takes a fresh snapshot.
 */
const threadListStream = (
  projectId: ProjectId | null,
  sequence: Ref.Ref<number | null>,
): Stream.Stream<
  ThreadListStreamItem,
  PoseidonRpcError | RpcClientError.RpcClientError,
  Connection | ConnectionStateRef
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connection = yield* Connection;
      const client = yield* connection.client;
      const connectionState = yield* ConnectionStateRef;
      const hello = yield* client["server.hello"]({});
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        yield* markIncompatible;
        return Stream.never;
      }
      const known = yield* SubscriptionRef.get(connectionState);
      const last = yield* Ref.get(sequence);
      const afterSequence =
        last === null || known.serverInstanceId !== hello.serverInstanceId ? undefined : last;
      if (afterSequence === undefined) {
        yield* Ref.set(sequence, null);
      }
      yield* markConnected(hello.serverInstanceId);
      return client["threads.listSubscribe"]({
        ...(projectId === null ? {} : { projectId }),
        ...(afterSequence === undefined ? {} : { afterSequence }),
      });
    }),
  ).pipe(Stream.retry(transportOnly()), Stream.repeat(resubscribeSchedule));

/**
 * A read model that has to be refetched after a reconnect. The socket carries
 * no invalidation, so "the connection came back" is the only signal the client
 * has that the server may have moved on while it was away.
 *
 * `SubscriptionRef.changes` replays the current state, so an atom mounted on a
 * live connection fetches straight away and one mounted before the first
 * connect fetches as soon as it lands — in both cases exactly once per
 * connected epoch.
 */
const perConnection = <A, E>(
  request: Effect.Effect<A, E, Connection>,
): Stream.Stream<A, E, Connection | ConnectionStateRef> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connectionState = yield* ConnectionStateRef;
      return SubscriptionRef.changes(connectionState).pipe(
        Stream.map((state) => state.status === "connected"),
        Stream.changes,
        Stream.filter((connected) => connected),
        Stream.mapEffect(() => request),
      );
    }),
  ).pipe(Stream.retry(transportOnly()));

/** The same treatment for a server-pushed stream: retry a drop, repeat a close. */
const perConnectionStream = <A, E>(
  subscribe: Effect.Effect<Stream.Stream<A, E>, E, Connection>,
): Stream.Stream<A, E, Connection | ConnectionStateRef> =>
  Stream.unwrap(subscribe).pipe(Stream.retry(transportOnly()), Stream.repeat(resubscribeSchedule));

export const makeRuntime = (connectionLayer: ConnectionLayer) => {
  // Build the connection inside the runtime's own scope so the supervisor's
  // fibers live exactly as long as the atoms that depend on them.
  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const ctx = yield* Layer.build(connectionLayer).pipe(Scope.provide(scope));
      return Layer.succeedContext(ctx);
    }),
  );
  const runtime = Atom.runtime(layer);

  const connectionStateAtom = runtime.atom(
    Effect.gen(function* () {
      const ref = yield* ConnectionStateRef;
      return SubscriptionRef.changes(ref);
    }).pipe(Stream.unwrap),
    { initialValue: { status: "connecting" as const, serverInstanceId: null } },
  );

  /**
   * Deliberately unseeded. An atom over a stream is `waiting` for as long as
   * the stream is open, which for a connection-scoped read model is forever —
   * so `waiting` cannot tell "has not answered" from "answered, and still
   * listening". With an `initialValue` of `[]` the atom reads as a *successful
   * empty list* from the first frame, and the first-run redirect on `/` could
   * not tell that apart from an install with no projects. Without one,
   * `Initial` means exactly "the server has not answered yet". Every reader
   * already falls back to `[]` for a non-success.
   */
  const projectsAtom = runtime.atom(
    perConnection(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["projects.list"]({});
      }),
    ),
  );

  /**
   * Pushed, not fetched once: a boot answers its first list before its probes
   * land, and a list read only then would show every harness as still probing
   * — able to run — until the next reconnect, so New task would keep starting
   * threads on one the server has since found signed out.
   */
  const connectorsAtom = runtime.atom(
    perConnectionStream(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return client["connectors.subscribe"]({});
      }),
    ),
    { initialValue: [] as ReadonlyArray<ConnectorSummary> },
  );

  /**
   * What the server's build ships, configured or not. Fixed for the life of a
   * server process, so one fetch per connected epoch is plenty.
   */
  const connectorDescriptorsAtom = runtime.atom(
    perConnection(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["connectors.describe"]({});
      }),
    ),
    { initialValue: [] as ReadonlyArray<ConnectorDescriptor> },
  );

  const settingsAtom = runtime.atom(
    perConnectionStream(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return client["settings.subscribe"]({});
      }),
    ),
    { initialValue: null as Settings | null },
  );

  const threadDetailAtom = Atom.family((threadId: ThreadId) =>
    runtime.atom(
      Effect.gen(function* () {
        const state = yield* Ref.make<ThreadDetailView | null>(null);
        return threadStream(threadId, state).pipe(
          Stream.mapEffect((item) =>
            Effect.gen(function* () {
              if (item.kind === "resnapshot-required") {
                yield* Ref.set(state, null);
              }
              return yield* Ref.updateAndGet(state, (doc) => applyThreadStreamItem(doc, item));
            }),
          ),
          Stream.filter((doc): doc is ThreadDetailView => doc !== null),
        );
      }).pipe(Stream.unwrap),
    ),
  );

  /**
   * Unseeded for the same reason as `projectsAtom`: `Initial` means the server
   * has not sent its snapshot yet, so a page can say "loading" instead of
   * reading a seed of `[]` as "there are no threads". Readers that only want
   * the rows fall back to `[]`.
   */
  const threadListAtom = Atom.family((projectId: ProjectId | null) =>
    runtime.atom(
      Effect.gen(function* () {
        const state = yield* Ref.make<ReadonlyArray<ThreadSummary>>([]);
        const sequence = yield* Ref.make<number | null>(null);
        return threadListStream(projectId, sequence).pipe(
          Stream.mapEffect((item: ThreadListStreamItem) =>
            Effect.gen(function* () {
              if (item.kind === "snapshot") {
                yield* Ref.set(sequence, item.snapshotSequence);
              } else if (item.kind === "resnapshot-required") {
                yield* Ref.set(sequence, null);
              }
              return yield* Ref.updateAndGet(state, (threads) =>
                applyThreadListItem(threads, item),
              );
            }),
          ),
        );
      }).pipe(Stream.unwrap),
    ),
  );

  /**
   * Sends a command and resolves with its receipt.
   *
   * Threads have `threads.listSubscribe` to tell the client what a command
   * changed, but projects have no subscription at all: `projectsAtom` is a
   * `perConnection` read model, so without a nudge here a `project.create`
   * the server *accepted* stays invisible until the socket reconnects — the
   * welcome flow navigates to an empty list and "Add project" closes onto a
   * sidebar that still says there are no projects. Refreshing from the one
   * place every command goes through keeps every caller honest instead of
   * asking each dialog to remember; refetching after `project.remove` matters
   * for the same reason. Only an accepted command moves the read model, so a
   * rejection re-fetches nothing.
   */
  const dispatchAtom = runtime.fn((command: Command, get) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      const receipt = yield* client["orchestration.dispatch"]({ command });
      if (
        receipt.status === "accepted" &&
        (command.type === "project.create" || command.type === "project.remove")
      ) {
        get.registry.refresh(projectsAtom);
      }
      return receipt;
    }),
  );

  /**
   * The composer's `#` file search, keyed per thread per query. The thread picks
   * the directory searched — its worktree, when it has one — so the scope is
   * part of the key; no thread (the start screen) searches the project's
   * folder. Each key is its own atom, so typing re-runs the RPC only
   * when the query text changes; the component supplies a deferred query
   * value for keystroke coalescing.
   */
  const fileSearchByScopeAtom = Atom.family((scope: string) =>
    Atom.family((query: string) =>
      runtime.atom(
        Effect.gen(function* () {
          const [projectId, threadId] = JSON.parse(scope) as [ProjectId, ThreadId | null];
          const client = yield* (yield* Connection).client;
          return yield* client["files.search"]({
            projectId,
            ...(threadId === null ? {} : { threadId }),
            query,
            limit: 20,
          });
        }),
        { initialValue: [] as ReadonlyArray<FileSearchResult> },
      ),
    ),
  );
  const fileSearchAtom = (projectId: ProjectId, threadId: ThreadId | null) =>
    fileSearchByScopeAtom(JSON.stringify([projectId, threadId]));

  /** The model list a connector instance reported, for the header picker. */
  const connectorModelsAtom = Atom.family((instanceId: ConnectorInstanceId | null) =>
    runtime.atom(
      instanceId === null
        ? Effect.succeed([] as ReadonlyArray<ModelOption>)
        : Effect.gen(function* () {
            const client = yield* (yield* Connection).client;
            return yield* client["connectors.models"]({ instanceId });
          }),
      { initialValue: [] as ReadonlyArray<ModelOption> },
    ),
  );

  /**
   * Skills one connector instance loads, per instance per project — the `/`
   * popover asks the thread's instance, the Customize page each instance with
   * a skills extension. No instance has none; `null` project is the user scope.
   */
  const skillsAtom = Atom.family((instanceId: ConnectorInstanceId | null) =>
    Atom.family((projectId: ProjectId | null) =>
      runtime.atom(
        instanceId === null
          ? Effect.succeed([] as ReadonlyArray<SkillSummary>)
          : Effect.gen(function* () {
              const client = yield* (yield* Connection).client;
              return yield* client["connectors.skills.list"]({
                instanceId,
                ...(projectId === null ? {} : { projectId }),
              });
            }),
        { initialValue: [] as ReadonlyArray<SkillSummary> },
      ),
    ),
  );

  /**
   * Plugins one connector instance has installed, per instance per project —
   * the `@` popover asks the thread's instance. Most harnesses have none, so an
   * instance without a plugins extension (`unavailable`) and no instance at
   * all both answer `[]`; any other failure surfaces.
   */
  const pluginsAtom = Atom.family((instanceId: ConnectorInstanceId | null) =>
    Atom.family((projectId: ProjectId | null) =>
      runtime.atom(
        instanceId === null
          ? Effect.succeed([] as ReadonlyArray<PluginSummary>)
          : Effect.gen(function* () {
              const client = yield* (yield* Connection).client;
              return yield* client["connectors.plugins.list"]({
                instanceId,
                ...(projectId === null ? {} : { projectId }),
              });
            }).pipe(
              Effect.catchIf(
                (error) =>
                  Predicate.isTagged(error, "PoseidonRpcError") && error.code === "unavailable",
                () => Effect.succeed([] as ReadonlyArray<PluginSummary>),
              ),
            ),
        { initialValue: [] as ReadonlyArray<PluginSummary> },
      ),
    ),
  );

  /**
   * The harness's own slash commands for one connector instance, per project —
   * the composer's `/` menu asks the thread's instance. An instance without a
   * commands extension (`unavailable`) and no instance at all both answer
   * `[]`, as plugins do; any other failure surfaces.
   */
  const harnessCommandsAtom = Atom.family((instanceId: ConnectorInstanceId | null) =>
    Atom.family((projectId: ProjectId | null) =>
      runtime.atom(
        instanceId === null
          ? Effect.succeed([] as ReadonlyArray<HarnessCommand>)
          : Effect.gen(function* () {
              const client = yield* (yield* Connection).client;
              return yield* client["connectors.commands.list"]({
                instanceId,
                ...(projectId === null ? {} : { projectId }),
              });
            }).pipe(
              Effect.catchIf(
                (error) =>
                  Predicate.isTagged(error, "PoseidonRpcError") && error.code === "unavailable",
                () => Effect.succeed([] as ReadonlyArray<HarnessCommand>),
              ),
            ),
        { initialValue: [] as ReadonlyArray<HarnessCommand> },
      ),
    ),
  );

  /**
   * Poseidon's own plugins — built-in and global, invalid ones with their
   * error — whatever harness a thread runs on. The composer's `@` menu lists
   * the enabled ones ahead of the instance's; the settings runtime refreshes
   * this after `plugins.setEnabled`.
   */
  const poseidonPluginsAtom = runtime.atom(
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return yield* client["plugins.list"]({});
    }),
  );

  /**
   * The user's keybinding overrides, as the server stores them. The editor and
   * the matcher layer them on `DEFAULT_KEYBINDINGS` with `resolveKeymap`.
   */
  const keybindingsAtom = runtime.atom(
    perConnection(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["keybindings.get"]({});
      }),
    ),
    { initialValue: [] as ReadonlyArray<Keybinding> },
  );

  /** Replaces the stored overrides; refreshes `keybindingsAtom` on success. */
  const keybindingsUpdateAtom = runtime.fn((keybindings: ReadonlyArray<Keybinding>, get) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      const next = yield* client["keybindings.update"]({ keybindings });
      get.registry.refresh(keybindingsAtom);
      return next;
    }),
  );

  // The thread's live browser state for the pane — `null` until the
  // server answers, then the latest BrowserState (mode, url, frame, activeTool).
  const browserStateAtom = Atom.family((threadId: ThreadId) =>
    runtime.atom(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return client["browser.subscribe"]({ threadId });
      }).pipe(Stream.unwrap, Stream.retry(transportOnly())),
      { initialValue: null as BrowserState | null },
    ),
  );

  /**
   * Uploads one composer image and resolves with the reference the turn will
   * carry. The bytes go up once; only the reference enters the command.
   */
  const stageAttachmentAtom = runtime.fn(
    (args: { readonly threadId: ThreadId; readonly name: string; readonly base64: string }) =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["attachments.stage"](args);
      }),
  );

  /**
   * A staged image, for a timeline thumbnail. Keyed per path, so a row that
   * rerenders does not re-fetch and two rows showing the same file share one
   * request. `null` until the server answers — the row shows a placeholder.
   */
  const attachmentAtom = Atom.family((threadId: ThreadId) =>
    Atom.family((path: string) =>
      runtime.atom(
        Effect.gen(function* () {
          const client = yield* (yield* Connection).client;
          return yield* client["attachments.read"]({ threadId, path });
        }),
        { initialValue: null as AttachmentBytes | null },
      ),
    ),
  );

  const sendBrowserInput = runtime.fn(
    (args: { readonly threadId: ThreadId; readonly input: BrowserHumanInput }) =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["browser.humanInput"]({
          threadId: args.threadId,
          input: args.input,
        });
      }),
  );

  return {
    runtime,
    connectionStateAtom,
    projectsAtom,
    connectorsAtom,
    connectorDescriptorsAtom,
    settingsAtom,
    threadDetailAtom,
    threadListAtom,
    dispatchAtom,
    fileSearchAtom,
    connectorModelsAtom,
    ...makeConnectorAtoms(runtime, connectorsAtom),
    skillsAtom,
    pluginsAtom,
    harnessCommandsAtom,
    poseidonPluginsAtom,
    keybindingsAtom,
    keybindingsUpdateAtom,
    browserStateAtom,
    sendBrowserInput,
    stageAttachmentAtom,
    attachmentAtom,
  };
};
