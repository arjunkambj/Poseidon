/**
 * Atom-level tests over a stubbed RPC client — the behaviour that lives
 * entirely in the client runtime: per-thread isolation, resnapshot handling,
 * and the `serverInstanceId` reset.
 */

import { type HarnessCommand, PoseidonRpcError, PROTOCOL_VERSION } from "@poseidon/contracts/rpc";
import { describe, expect, it } from "@effect/vitest";
import type { ConnectorInstanceId, ProjectId, ThreadId } from "@poseidon/contracts/ids";
import {
  makeCommandId,
  makeEventId,
  makeItemId,
  makeProjectId,
  makeThreadId,
} from "@poseidon/contracts/ids";
import type {
  Command,
  CommandReceipt,
  ProjectSummary,
  ThreadDetailSnapshot,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "@poseidon/contracts/orchestration";
import type {
  ConnectorSummary,
  ModelOption,
  PluginSummary,
  SkillSummary,
} from "@poseidon/contracts/connectors";
import type { PluginsState, PoseidonPlugin } from "@poseidon/contracts/plugins";
import type { Settings } from "@poseidon/contracts/settings";
import { defaultSettings } from "@poseidon/contracts/settings";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  markConnected,
  setConnectionStatus,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";

const INSTANCE = "01900000-0000-7000-8000-000000000000";

const snapshot = (
  threadId: ThreadId,
  items: ThreadDetailSnapshot["items"] = [],
): ThreadDetailSnapshot => ({
  threadId,
  projectId: makeProjectId(),
  title: "test",
  status: "idle",
  settings: {
    model: "fake/model",
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
  },
  snapshotSequence: 1,
  items,
  queue: [],
  checkpoints: [],
  session: null,
  currentTurnId: null,
  pendingApproval: null,
  pendingUserInput: null,
  pendingPlan: null,
  usage: null,
  context: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const upsert = (threadId: ThreadId, sequence: number, text: string): ThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: makeEventId(),
    type: "thread.item.upserted",
    sequence,
    streamKind: "thread",
    streamId: threadId,
    streamVersion: sequence,
    occurredAt: "2026-01-01T00:00:00.000Z",
    actor: "connector",
    payload: {
      item: {
        itemId: makeItemId(),
        kind: "assistant_message",
        status: "completed",
        text,
      },
    },
  },
});

/** How a test feeds `threads.listSubscribe` and reads back what it was asked. */
interface ListChannel {
  readonly queue: () => Queue.Queue<ThreadListStreamItem, unknown>;
  readonly calls: Array<{ readonly afterSequence?: number }>;
}

/** The read models a test wants the stub to answer. */
interface StubData {
  readonly list?: ListChannel;
  readonly projects?: Ref.Ref<ReadonlyArray<ProjectSummary>>;
  /** Answers `projects.list` itself — how a test makes the read model fail. */
  readonly projectsRequest?: () => Effect.Effect<ReadonlyArray<ProjectSummary>, PoseidonRpcError>;
  readonly settings?: () => Queue.Queue<Settings, unknown>;
  /** Answers `orchestration.dispatch` — how a test accepts or rejects one. */
  readonly dispatch?: (command: Command) => CommandReceipt;
  /** What `server.hello` claims to speak; defaults to this build's version. */
  readonly protocolVersion?: number;
  /** Answers `connectors.list`. */
  readonly connectors?: ReadonlyArray<ConnectorSummary>;
  /** Answers `connectors.models` per instance — how a test makes one fail. */
  readonly models?: (
    instanceId: ConnectorInstanceId,
  ) => Effect.Effect<ReadonlyArray<ModelOption>, PoseidonRpcError>;
  /** Answers `connectors.skills.list`, given the whole payload. */
  readonly skills?: (payload: {
    readonly instanceId: ConnectorInstanceId;
    readonly projectId?: ProjectId;
  }) => ReadonlyArray<SkillSummary>;
  /** Answers `connectors.plugins.list` per instance — how a test makes one fail. */
  readonly plugins?: (
    instanceId: ConnectorInstanceId,
  ) => Effect.Effect<ReadonlyArray<PluginSummary>, PoseidonRpcError>;
  /** Answers `connectors.commands.list`, given the whole payload. */
  readonly commands?: (payload: {
    readonly instanceId: ConnectorInstanceId;
    readonly projectId?: ProjectId;
  }) => Effect.Effect<ReadonlyArray<HarnessCommand>, PoseidonRpcError>;
  /** Answers `plugins.list` — Poseidon's own plugins. */
  readonly poseidonPlugins?: () => PluginsState;
}

/**
 * A client stub: `server.hello` answers the current instance id,
 * `threads.subscribe` drains the per-thread queue (or hangs forever when the
 * thread is unknown), `threads.listSubscribe` drains whatever queue the
 * channel currently points at (recording each subscribe payload), and the read
 * models answer from whatever the test last put in front of them.
 */
const fakeClient = (
  streams: Map<string, Queue.Queue<ThreadStreamItem, unknown>>,
  instanceId: Ref.Ref<string>,
  data: StubData = {},
): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      if (key === "server.hello") {
        return () =>
          Ref.get(instanceId).pipe(
            Effect.map((serverInstanceId) => ({
              protocolVersion: data.protocolVersion ?? PROTOCOL_VERSION,
              serverInstanceId,
            })),
          );
      }
      if (key === "threads.subscribe") {
        return ({ threadId }: { threadId: string }) => {
          const queue = streams.get(threadId);
          return queue === undefined ? Stream.never : Stream.fromQueue(queue);
        };
      }
      if (key === "threads.listSubscribe" && data.list !== undefined) {
        const list = data.list;
        return (payload: { afterSequence?: number }) => {
          list.calls.push(payload);
          return Stream.suspend(() => Stream.fromQueue(list.queue()));
        };
      }
      if (key === "projects.list" && data.projectsRequest !== undefined) {
        const request = data.projectsRequest;
        return () => request();
      }
      if (key === "projects.list" && data.projects !== undefined) {
        const projects = data.projects;
        return () => Ref.get(projects);
      }
      if (key === "orchestration.dispatch" && data.dispatch !== undefined) {
        const dispatch = data.dispatch;
        return ({ command }: { command: Command }) => Effect.sync(() => dispatch(command));
      }
      if (key === "connectors.list" && data.connectors !== undefined) {
        const connectors = data.connectors;
        return () => Effect.succeed(connectors);
      }
      if (key === "connectors.models" && data.models !== undefined) {
        const models = data.models;
        return ({ instanceId }: { instanceId: ConnectorInstanceId }) => models(instanceId);
      }
      if (key === "connectors.skills.list" && data.skills !== undefined) {
        const skills = data.skills;
        return (payload: { instanceId: ConnectorInstanceId; projectId?: ProjectId }) =>
          Effect.sync(() => skills(payload));
      }
      if (key === "connectors.plugins.list" && data.plugins !== undefined) {
        const plugins = data.plugins;
        return ({ instanceId }: { instanceId: ConnectorInstanceId }) => plugins(instanceId);
      }
      if (key === "connectors.commands.list" && data.commands !== undefined) {
        const commands = data.commands;
        return (payload: { instanceId: ConnectorInstanceId; projectId?: ProjectId }) =>
          commands(payload);
      }
      if (key === "plugins.list" && data.poseidonPlugins !== undefined) {
        const poseidonPlugins = data.poseidonPlugins;
        return () => Effect.sync(poseidonPlugins);
      }
      if (key === "settings.subscribe" && data.settings !== undefined) {
        const settings = data.settings;
        return () => Stream.suspend(() => Stream.fromQueue(settings()));
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const summary = (threadId: ThreadId, title: string): ThreadSummary => ({
  threadId,
  projectId: makeProjectId(),
  title,
  status: "idle",
  settings: {
    model: "fake/model",
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
  },
  awaitingInput: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const project = (name: string): ProjectSummary => ({
  projectId: makeProjectId(),
  name,
  workspaceRoot: `/repo/${name}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  threadCount: 0,
});

const connectorSummary = (id: string, enabled: boolean): ConnectorSummary => ({
  connectorInstanceId: id as ConnectorInstanceId,
  kind: "harness",
  displayName: `Instance ${id}`,
  enabled,
  capabilities: null,
  extensions: { skills: false, plugins: false, mcpServers: false },
  probe: { status: "ready", probedAt: "2026-01-01T00:00:00.000Z" },
});

const model = (id: string): ModelOption => ({ id, label: id, family: "test", efforts: [] });

const runtimeWith = (client: PoseidonRpcClient, state: ConnectionState) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(state);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, {
        client: Effect.succeed(client),
        state: stateRef,
      }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    return { registry: AtomRegistry.make(), stateRef, ...makeRuntime(layer) };
  });

/** Awaits the first success value matching the predicate — no timers in logic. */
const awaitValue = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean,
): Promise<A> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (AsyncResult.isSuccess(result) && predicate(result.value)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    // `subscribe` only fires on change — replay the current value explicitly.
    check(registry.get(atom));
  });

/** The first answer that is no longer waiting, success or failure. */
const awaitSettled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Promise<AsyncResult.AsyncResult<A, E>> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (!AsyncResult.isInitial(result) && !result.waiting) {
        unmount();
        resolve(result);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

/** The mirror of `awaitValue` for the error channel — also timer-free. */
const awaitFailure = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Promise<E> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (AsyncResult.isFailure(result)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
        if (error !== undefined) {
          unmount();
          resolve(error);
        }
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("atoms", () => {
  it.live("thread detail atoms update only for their own thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadA = makeThreadId();
        const threadB = makeThreadId();
        const queueA = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const queueB = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const streams = new Map<string, Queue.Queue<ThreadStreamItem, unknown>>([
          [threadA, queueA],
          [threadB, queueB],
        ]);
        const { registry, threadDetailAtom } = yield* runtimeWith(fakeClient(streams, instance), {
          status: "connecting",
          serverInstanceId: null,
        });

        const atomA = threadDetailAtom(threadA);
        const atomB = threadDetailAtom(threadB);
        registry.mount(atomA);
        registry.mount(atomB);

        // Baseline snapshots for both threads.
        yield* Queue.offer(queueA, {
          kind: "snapshot",
          snapshot: snapshot(threadA),
        });
        yield* Queue.offer(queueB, {
          kind: "snapshot",
          snapshot: snapshot(threadB),
        });
        yield* Effect.promise(() => awaitValue(registry, atomA, (doc) => doc !== null));
        yield* Effect.promise(() => awaitValue(registry, atomB, (doc) => doc !== null));

        // An event scoped to A must not touch B.
        yield* Queue.offer(queueA, upsert(threadA, 2, "hello A"));
        yield* Effect.promise(() => awaitValue(registry, atomA, (doc) => doc.items.length === 1));
        const docB = registry.get(atomB);
        expect(AsyncResult.isSuccess(docB) && docB.value.items.length).toBe(0);
      }),
    ),
  );

  it.live("resnapshot-required clears the doc and the next snapshot replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const { registry, threadDetailAtom } = yield* runtimeWith(
          fakeClient(new Map([[threadId, queue]]), instance),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadDetailAtom(threadId);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshot: snapshot(threadId),
        });
        yield* Queue.offer(queue, upsert(threadId, 2, "old item"));
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 1));

        yield* Queue.offer(queue, { kind: "resnapshot-required", reason: "budget" });
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshot: snapshot(threadId, []),
        });
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 0));
      }),
    ),
  );

  it.live("a subscription that ends after resnapshot-required resubscribes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const streams = new Map<string, Queue.Queue<ThreadStreamItem, unknown>>([
          [threadId, queue],
        ]);
        const { registry, threadDetailAtom } = yield* runtimeWith(fakeClient(streams, instance), {
          status: "connecting",
          serverInstanceId: null,
        });

        const atom = threadDetailAtom(threadId);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshot: snapshot(threadId),
        });
        yield* Queue.offer(queue, upsert(threadId, 2, "old item"));
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 1));

        // The server ends the stream cleanly after resnapshot-required —
        // `Stream.retry` alone never fires on a clean end, so the atom must
        // resubscribe itself. The swapped-in queue stands in for the fresh
        // subscription the repeat opens.
        yield* Queue.offer(queue, { kind: "resnapshot-required", reason: "budget" });
        yield* Queue.end(queue);

        const queue2 = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        streams.set(threadId, queue2);
        yield* Queue.offer(queue2, {
          kind: "snapshot",
          snapshot: snapshot(threadId, []),
        });
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 0));
      }),
    ),
  );

  it.live("the thread list reads as not answered until the server's snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        const queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        const list: ListChannel = { queue: () => queue, calls: [] };
        const { registry, threadListAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { list }),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadListAtom(null);
        registry.mount(atom);
        // A seed of `[]` here read as the server saying "no threads", so the
        // archived threads page claimed there were none while it loaded.
        expect(AsyncResult.isInitial(registry.get(atom))).toBe(true);

        yield* Queue.offer(queue, { kind: "snapshot", snapshotSequence: 1, threads: [] });
        const threads = yield* Effect.promise(() => awaitValue(registry, atom, () => true));
        expect(threads).toEqual([]);
      }),
    ),
  );

  it.live("the thread list survives a dropped subscription and resumes from its snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadA = makeThreadId();
        const threadB = makeThreadId();
        const instance = yield* Ref.make(INSTANCE);
        let queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        const list: ListChannel = { queue: () => queue, calls: [] };
        const { registry, threadListAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { list }),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadListAtom(null);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshotSequence: 7,
          threads: [summary(threadA, "first")],
        });
        yield* Effect.promise(() => awaitValue(registry, atom, (threads) => threads.length === 1));

        // The socket drops mid-subscription. Before the fix the atom held a
        // dead client and retried against it forever, so the sidebar froze.
        const dropped = queue;
        queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        yield* Queue.offer(queue, { kind: "upserted", thread: summary(threadB, "second") });
        yield* Queue.fail(dropped, new Error("socket dropped"));

        const threads = yield* Effect.promise(() =>
          awaitValue(registry, atom, (value) => value.length === 2),
        );
        expect(threads.map((t) => t.title)).toEqual(["first", "second"]);
        // The resubscribe asked for catch-up from the snapshot it holds.
        expect(list.calls.at(-1)?.afterSequence).toBe(7);
      }),
    ),
  );

  it.live("resnapshot-required clears the thread list and drops the resume point", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadA = makeThreadId();
        const instance = yield* Ref.make(INSTANCE);
        let queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        const list: ListChannel = { queue: () => queue, calls: [] };
        const { registry, threadListAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { list }),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadListAtom(null);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshotSequence: 7,
          threads: [summary(threadA, "first")],
        });
        yield* Effect.promise(() => awaitValue(registry, atom, (threads) => threads.length === 1));

        // The server gives up on replay and ends the stream cleanly — only the
        // `repeat` reopens it, and the next subscribe must not resume from 7.
        yield* Queue.offer(queue, { kind: "resnapshot-required", reason: "budget" });
        yield* Effect.promise(() => awaitValue(registry, atom, (threads) => threads.length === 0));
        const ended = queue;
        queue = yield* Queue.unbounded<ThreadListStreamItem, unknown>();
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshotSequence: 11,
          threads: [summary(threadA, "rebuilt")],
        });
        yield* Queue.end(ended);

        const threads = yield* Effect.promise(() =>
          awaitValue(registry, atom, (value) => value.some((t) => t.title === "rebuilt")),
        );
        expect(threads.length).toBe(1);
        expect(list.calls.at(-1)?.afterSequence).toBeUndefined();
      }),
    ),
  );

  it.live("a request read model refetches when the connection comes back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        const projects = yield* Ref.make<ReadonlyArray<ProjectSummary>>([project("one")]);
        const { registry, stateRef, projectsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { projects }),
          { status: "connecting", serverInstanceId: null },
        );

        registry.mount(projectsAtom);
        yield* SubscriptionRef.set(stateRef, { status: "connected", serverInstanceId: INSTANCE });
        yield* Effect.promise(() =>
          awaitValue(registry, projectsAtom, (list) => list.length === 1),
        );

        // The server gained a project while the socket was down. Nothing
        // pushes projects, so the reconnect is the only cue to refetch.
        yield* Ref.set(projects, [project("one"), project("two")]);
        yield* SubscriptionRef.set(stateRef, {
          status: "reconnecting",
          serverInstanceId: INSTANCE,
        });
        yield* SubscriptionRef.set(stateRef, { status: "connected", serverInstanceId: INSTANCE });

        const list = yield* Effect.promise(() =>
          awaitValue(registry, projectsAtom, (value) => value.length === 2),
        );
        expect(list.map((p) => p.name)).toEqual(["one", "two"]);
      }),
    ),
  );

  it.live("an accepted project command refetches the project list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        const projects = yield* Ref.make<ReadonlyArray<ProjectSummary>>([project("one")]);
        let calls = 0;
        const { registry, projectsAtom, dispatchAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, {
            projectsRequest: () => {
              calls += 1;
              return Ref.get(projects);
            },
            dispatch: (command) => ({
              commandId: command.commandId,
              // The workspace root a rejection would complain about; the
              // accepted one is the second command this test sends.
              status:
                command.type === "project.create" && command.name === "taken"
                  ? "rejected"
                  : "accepted",
              lastSequence: 7,
            }),
          }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        registry.mount(projectsAtom);
        registry.mount(dispatchAtom);
        yield* Effect.promise(() =>
          awaitValue(registry, projectsAtom, (list) => list.length === 1),
        );

        // Nothing pushes projects, so without a refresh here the list the
        // welcome flow navigates to stays empty until the socket reconnects.
        yield* Ref.set(projects, [project("one"), project("two")]);

        // A rejected create changed nothing on the server, so it must not
        // refetch — sent first so an unwanted refetch would be counted by the
        // time the accepted one below has landed.
        const createCommand = (name: string): Command => ({
          commandId: makeCommandId(),
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "project.create",
          projectId: makeProjectId(),
          name,
          workspaceRoot: `/repo/${name}`,
        });
        registry.set(dispatchAtom, createCommand("taken"));
        yield* Effect.promise(() =>
          awaitValue(registry, dispatchAtom, (receipt) => receipt.status === "rejected"),
        );

        registry.set(dispatchAtom, createCommand("two"));
        const list = yield* Effect.promise(() =>
          awaitValue(registry, projectsAtom, (value) => value.length === 2),
        );
        expect(list.map((p) => p.name)).toEqual(["one", "two"]);
        expect(calls).toBe(2);
      }),
    ),
  );

  it.live("a read model that the server refuses surfaces instead of looping", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        let calls = 0;
        const { registry, projectsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, {
            projectsRequest: () => {
              calls += 1;
              return Effect.fail(
                new PoseidonRpcError({ code: "internal", message: "bad row in the read model" }),
              );
            },
          }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        // A domain error is the server's answer, not a hiccup. Retrying it
        // hammered the server every two seconds forever while the page showed
        // the empty initial value, indistinguishable from "no projects".
        registry.mount(projectsAtom);
        const failure = yield* Effect.promise(() => awaitFailure(registry, projectsAtom));
        expect(failure).toBeInstanceOf(PoseidonRpcError);
        expect(calls).toBe(1);
      }),
    ),
  );

  it.live("the model catalog groups enabled instances in list order and isolates failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        const asked: Array<string> = [];
        const { registry, modelCatalogAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, {
            connectors: [
              connectorSummary("b", true),
              connectorSummary("off", false),
              connectorSummary("broken", true),
              connectorSummary("a", true),
            ],
            models: (instanceId) => {
              asked.push(instanceId);
              return instanceId === "broken"
                ? Effect.fail(new PoseidonRpcError({ code: "internal", message: "no models" }))
                : Effect.succeed([model(`${instanceId}/one`), model(`${instanceId}/two`)]);
            },
          }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        registry.mount(modelCatalogAtom);
        const catalog = yield* Effect.promise(() =>
          awaitValue(registry, modelCatalogAtom, (groups) => groups.length > 0),
        );
        // `connectors.list` order, not alphabetical; the disabled instance is
        // neither listed nor asked; the failing one lists nothing and leaves
        // its neighbours alone.
        expect(
          catalog.map((group) => [
            group.connector.connectorInstanceId,
            group.models.map((entry) => entry.id),
          ]),
        ).toEqual([
          ["b", ["b/one", "b/two"]],
          ["broken", []],
          ["a", ["a/one", "a/two"]],
        ]);
        expect(asked).not.toContain("off");
      }),
    ),
  );

  it.live("skills come from the instance asked, and no instance has none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        const asked: Array<unknown> = [];
        const projectId = makeProjectId();
        const { registry, skillsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, {
            skills: (payload) => {
              asked.push(payload);
              return [{ name: `${payload.instanceId}-skill`, path: "/skill.md", enabled: true }];
            },
          }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        // No instance: answered locally — the stub would die on any RPC.
        const none = skillsAtom(null)(projectId);
        registry.mount(none);
        expect(yield* Effect.promise(() => awaitValue(registry, none, () => true))).toEqual([]);

        const scoped = skillsAtom("a" as ConnectorInstanceId)(projectId);
        registry.mount(scoped);
        const skills = yield* Effect.promise(() =>
          awaitValue(registry, scoped, (value) => value.length > 0),
        );
        expect(skills.map((skill) => skill.name)).toEqual(["a-skill"]);
        expect(asked).toEqual([{ instanceId: "a", projectId }]);
      }),
    ),
  );

  it.live("plugins answer [] for no instance and for one without the extension", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        const asked: Array<ConnectorInstanceId> = [];
        const projectId = makeProjectId();
        const plugin: PluginSummary = { name: "formatter", scope: "user", enabled: true };
        const { registry, pluginsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, {
            plugins: (instanceId) => {
              asked.push(instanceId);
              if (instanceId === "with") {
                return Effect.succeed([plugin]);
              }
              return Effect.fail(
                new PoseidonRpcError({
                  code: instanceId === "without" ? "unavailable" : "internal",
                  message: `no plugins on ${instanceId}`,
                }),
              );
            },
          }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        // No instance: answered locally — nothing is asked.
        const none = pluginsAtom(null)(projectId);
        registry.mount(none);
        const noneResult = yield* Effect.promise(() => awaitSettled(registry, none));
        expect(AsyncResult.isSuccess(noneResult) && noneResult.value).toEqual([]);

        const listed = pluginsAtom("with" as ConnectorInstanceId)(projectId);
        registry.mount(listed);
        const plugins = yield* Effect.promise(() =>
          awaitValue(registry, listed, (value) => value.length > 0),
        );
        expect(plugins).toEqual([plugin]);

        // An instance without the extension is asked, and its refusal is an
        // empty list rather than an error the '@' menu would have to show.
        const without = pluginsAtom("without" as ConnectorInstanceId)(projectId);
        registry.mount(without);
        const withoutResult = yield* Effect.promise(() => awaitSettled(registry, without));
        expect(AsyncResult.isSuccess(withoutResult) && withoutResult.value).toEqual([]);

        // Any other failure still surfaces.
        const broken = pluginsAtom("broken" as ConnectorInstanceId)(null);
        registry.mount(broken);
        const error = yield* Effect.promise(() => awaitFailure(registry, broken));
        expect(error).toMatchObject({ code: "internal" });

        expect(asked).toEqual(["with", "without", "broken"]);
      }),
    ),
  );

  it.live("harness commands answer [] for no instance and for one without the extension", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        const asked: Array<{ instanceId: ConnectorInstanceId; projectId?: ProjectId }> = [];
        const projectId = makeProjectId();
        const command: HarnessCommand = { name: "review", argumentHint: "[focus]" };
        const { registry, harnessCommandsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, {
            commands: (payload) => {
              asked.push(payload);
              if (payload.instanceId === "with") return Effect.succeed([command]);
              return Effect.fail(
                new PoseidonRpcError({
                  code: payload.instanceId === "without" ? "unavailable" : "internal",
                  message: `no commands on ${payload.instanceId}`,
                }),
              );
            },
          }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        // No instance: answered locally — nothing is asked.
        const none = harnessCommandsAtom(null)(projectId);
        registry.mount(none);
        const noneResult = yield* Effect.promise(() => awaitSettled(registry, none));
        expect(AsyncResult.isSuccess(noneResult) && noneResult.value).toEqual([]);

        const listed = harnessCommandsAtom("with" as ConnectorInstanceId)(projectId);
        registry.mount(listed);
        const commands = yield* Effect.promise(() =>
          awaitValue(registry, listed, (value) => value.length > 0),
        );
        expect(commands).toEqual([command]);

        // An instance without the extension answers an empty menu group.
        const without = harnessCommandsAtom("without" as ConnectorInstanceId)(null);
        registry.mount(without);
        const withoutResult = yield* Effect.promise(() => awaitSettled(registry, without));
        expect(AsyncResult.isSuccess(withoutResult) && withoutResult.value).toEqual([]);

        // Any other failure still surfaces.
        const broken = harnessCommandsAtom("broken" as ConnectorInstanceId)(null);
        registry.mount(broken);
        const error = yield* Effect.promise(() => awaitFailure(registry, broken));
        expect(error).toMatchObject({ code: "internal" });

        expect(asked).toEqual([
          { instanceId: "with", projectId },
          { instanceId: "without" },
          { instanceId: "broken" },
        ]);
      }),
    ),
  );

  it.live("poseidon's plugins come from plugins.list and read again on refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        let asked = 0;
        const browser: PoseidonPlugin = {
          pluginId: "builtin:browser",
          name: "browser",
          source: "builtin",
          path: "/home/.poseidon/builtin-plugins/browser",
          enabled: true,
          contents: {
            skills: [{ name: "browser" }],
            mcpServers: [],
            commands: 0,
            agents: 0,
            hooks: false,
          },
        };
        const { registry, poseidonPluginsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, {
            poseidonPlugins: () => {
              asked += 1;
              return {
                globalDir: "/home/.poseidon/plugins",
                plugins: [{ ...browser, enabled: asked === 1 }],
              };
            },
          }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        registry.mount(poseidonPluginsAtom);
        const first = yield* Effect.promise(() =>
          awaitValue(registry, poseidonPluginsAtom, () => true),
        );
        expect(first.globalDir).toBe("/home/.poseidon/plugins");
        expect(first.plugins.map((plugin) => [plugin.pluginId, plugin.enabled])).toEqual([
          ["builtin:browser", true],
        ]);

        registry.refresh(poseidonPluginsAtom);
        const second = yield* Effect.promise(() =>
          awaitValue(registry, poseidonPluginsAtom, (state) => !state.plugins[0]!.enabled),
        );
        expect(second.plugins[0]?.enabled).toBe(false);
        expect(asked).toBe(2);
      }),
    ),
  );

  it.live("settings recover after the subscription drops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* Ref.make(INSTANCE);
        let queue = yield* Queue.unbounded<Settings, unknown>();
        const { registry, settingsAtom } = yield* runtimeWith(
          fakeClient(new Map(), instance, { settings: () => queue }),
          { status: "connected", serverInstanceId: INSTANCE },
        );

        registry.mount(settingsAtom);
        yield* Queue.offer(queue, { ...defaultSettings(), theme: "light" });
        yield* Effect.promise(() =>
          awaitValue(registry, settingsAtom, (value) => value?.theme === "light"),
        );

        // Before the fix the atom failed here and stayed failed forever, so
        // the settings pane was frozen for the rest of the session.
        const dropped = queue;
        queue = yield* Queue.unbounded<Settings, unknown>();
        yield* Queue.offer(queue, { ...defaultSettings(), theme: "dark" });
        yield* Queue.fail(dropped, new Error("socket dropped"));

        yield* Effect.promise(() =>
          awaitValue(registry, settingsAtom, (value) => value?.theme === "dark"),
        );
      }),
    ),
  );

  it.live("a changed serverInstanceId discards the cached snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const streams = new Map<string, Queue.Queue<ThreadStreamItem, unknown>>([
          [threadId, queue],
        ]);
        const { registry, stateRef, threadDetailAtom } = yield* runtimeWith(
          fakeClient(streams, instance),
          { status: "connecting", serverInstanceId: null },
        );

        const atom = threadDetailAtom(threadId);
        registry.mount(atom);
        yield* Queue.offer(queue, {
          kind: "snapshot",
          snapshot: snapshot(threadId),
        });
        yield* Queue.offer(queue, upsert(threadId, 2, "kept?"));
        yield* Effect.promise(() => awaitValue(registry, atom, (doc) => doc.items.length === 1));

        // Simulate a server restart: the instance id changes, so the next
        // subscribe attempt must not resume with the old sequence. Ending the
        // queue forces the stream loop to re-run; the swapped-in queue stands
        // in for the fresh subscription the retry opens.
        yield* Ref.set(instance, "01900000-0000-7000-8000-000000000001");
        yield* SubscriptionRef.set(stateRef, {
          status: "reconnecting",
          serverInstanceId: null,
        });
        const queue2 = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        streams.set(threadId, queue2);
        // A failed stream triggers the retry loop — an ended one does not.
        yield* Queue.fail(queue, new Error("socket dropped"));

        yield* Queue.offer(queue2, {
          kind: "snapshot",
          snapshot: snapshot(threadId, []),
        });
        const doc = yield* Effect.promise(() =>
          awaitValue(registry, atom, (d) => d.items.length === 0),
        );
        expect(doc.items.length).toBe(0);
      }),
    ),
  );

  it.live("a server on another protocol version parks instead of subscribing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const { registry, stateRef, threadDetailAtom } = yield* runtimeWith(
          fakeClient(new Map([[threadId, queue]]), instance, {
            protocolVersion: PROTOCOL_VERSION + 1,
          }),
          { status: "connecting", serverInstanceId: null },
        );

        registry.mount(threadDetailAtom(threadId));
        // Decoding the other build's frames would fail opaquely, so the atom
        // must never subscribe; the banner reads the status instead.
        const seen = yield* SubscriptionRef.changes(stateRef).pipe(
          Stream.filter((state) => state.status === "incompatible"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        expect(seen[0]?.status).toBe("incompatible");

        // A snapshot on the wire must not reach the atom.
        yield* Queue.offer(queue, { kind: "snapshot", snapshot: snapshot(threadId) });
        const result = registry.get(threadDetailAtom(threadId));
        expect(AsyncResult.isSuccess(result)).toBe(false);
      }),
    ),
  );

  it.live("a parked protocol mismatch survives a later reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const queue = yield* Queue.unbounded<ThreadStreamItem, unknown>();
        const instance = yield* Ref.make(INSTANCE);
        const { registry, stateRef, threadDetailAtom } = yield* runtimeWith(
          fakeClient(new Map([[threadId, queue]]), instance, {
            protocolVersion: PROTOCOL_VERSION + 1,
          }),
          { status: "connecting", serverInstanceId: null },
        );

        registry.mount(threadDetailAtom(threadId));
        yield* SubscriptionRef.changes(stateRef).pipe(
          Stream.filter((state) => state.status === "incompatible"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );

        // The socket drops for an ordinary reason and the supervisor
        // reconnects. Nothing re-runs the parked subscribers, so a status that
        // moved back to `connected` here would hide the "update to continue"
        // banner over a permanently silent UI.
        yield* setConnectionStatus(stateRef, "reconnecting");
        yield* setConnectionStatus(stateRef, "connected");
        expect((yield* SubscriptionRef.get(stateRef)).status).toBe("incompatible");

        // `server.hello` answering again must not move it either.
        yield* markConnected(INSTANCE).pipe(Effect.provideService(ConnectionStateRef, stateRef));
        expect((yield* SubscriptionRef.get(stateRef)).status).toBe("incompatible");
      }),
    ),
  );
});
