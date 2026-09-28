/**
 * The editor atoms over a stubbed RPC client. What the "Open in" control and
 * the file menus rely on: nothing is listed offline, a connection lists once,
 * a failed listing is the empty list (the control hides) and a reconnect
 * lists again, and an open sends only the fields it was given and resolves
 * with the server's refusal as a value.
 */

import { describe, expect, it } from "@effect/vitest";
import type { DetectedEditor } from "@poseidon/contracts/editors";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";
import { makeEditorAtoms } from "./editors";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

const EDITORS: ReadonlyArray<DetectedEditor> = [
  { id: "cursor", label: "Cursor", kind: "editor", supportsLine: true },
  { id: "finder", label: "Finder", kind: "file-manager", supportsLine: false },
];

interface Calls {
  readonly list: Array<unknown>;
  readonly open: Array<unknown>;
}

const fakeClient = (calls: Calls, failing: Ref.Ref<boolean>): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      if (key === "editors.list") {
        return (payload: unknown) =>
          Effect.gen(function* () {
            calls.list.push(payload);
            if (yield* Ref.get(failing)) {
              return yield* Effect.fail(
                new PoseidonRpcError({ code: "internal", message: "detection failed" }),
              );
            }
            return EDITORS;
          });
      }
      if (key === "editors.open") {
        return (payload: { path?: string }) =>
          Effect.gen(function* () {
            calls.open.push(payload);
            if (payload.path === "../outside") {
              return yield* Effect.fail(
                new PoseidonRpcError({ code: "invalid", message: "Outside the workspace." }),
              );
            }
            return {};
          });
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const runtimeWith = (initial: ConnectionState, failing = false) =>
  Effect.gen(function* () {
    const calls: Calls = { list: [], open: [] };
    const failingRef = yield* Ref.make(failing);
    const stateRef = yield* SubscriptionRef.make(initial);
    const client = fakeClient(calls, failingRef);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    return {
      calls,
      failing: failingRef,
      stateRef,
      registry: AtomRegistry.make(),
      ...makeEditorAtoms(base.runtime),
    };
  });

type Listing = AsyncResult.AsyncResult<ReadonlyArray<DetectedEditor>, unknown>;

/** Resolves on the first listing matching the predicate — no timers in logic. */
const awaitListing = (
  registry: AtomRegistry.AtomRegistry,
  atom: ReturnType<typeof makeEditorAtoms>["editorsAtom"],
  predicate: (value: ReadonlyArray<DetectedEditor>) => boolean,
): Promise<ReadonlyArray<DetectedEditor>> =>
  new Promise((resolve) => {
    const check = (result: Listing) => {
      if (AsyncResult.isSuccess(result) && predicate(result.value)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

const PROJECT = makeProjectId();
const THREAD = makeThreadId();

describe("editor atoms", () => {
  it.live("offline, lists nothing and stays Initial", () =>
    Effect.gen(function* () {
      const { calls, registry, editorsAtom } = yield* runtimeWith(RECONNECTING);
      registry.mount(editorsAtom);
      yield* Effect.yieldNow;
      expect(AsyncResult.isInitial(registry.get(editorsAtom))).toBe(true);
      expect(calls.list).toEqual([]);
    }),
  );

  it.live("lists once when connected", () =>
    Effect.gen(function* () {
      const { calls, registry, editorsAtom } = yield* runtimeWith(CONNECTED);
      registry.mount(editorsAtom);
      const listed = yield* Effect.promise(() =>
        awaitListing(registry, editorsAtom, (value) => value.length > 0),
      );
      expect(listed).toEqual(EDITORS);
      expect(calls.list).toEqual([{}]);
    }),
  );

  it.live("a failed listing is the empty list, and a reconnect lists again", () =>
    Effect.gen(function* () {
      const { calls, failing, stateRef, registry, editorsAtom } = yield* runtimeWith(
        CONNECTED,
        true,
      );
      registry.mount(editorsAtom);
      const empty = yield* Effect.promise(() => awaitListing(registry, editorsAtom, () => true));
      expect(empty).toEqual([]);

      yield* Ref.set(failing, false);
      yield* SubscriptionRef.set(stateRef, RECONNECTING);
      yield* SubscriptionRef.set(stateRef, CONNECTED);
      const listed = yield* Effect.promise(() =>
        awaitListing(registry, editorsAtom, (value) => value.length > 0),
      );
      expect(listed).toEqual(EDITORS);
      expect(calls.list).toHaveLength(2);
    }),
  );

  it.live("an open sends only the fields it was given", () =>
    Effect.gen(function* () {
      const { calls, registry, openIn } = yield* runtimeWith(CONNECTED);
      const root = yield* Effect.promise(() =>
        openIn(registry, { projectId: PROJECT, editor: "cursor" }),
      );
      const file = yield* Effect.promise(() =>
        openIn(registry, {
          projectId: PROJECT,
          threadId: THREAD,
          editor: "cursor",
          path: "src/index.ts",
          line: 12,
        }),
      );
      const reveal = yield* Effect.promise(() =>
        openIn(registry, {
          projectId: PROJECT,
          editor: "finder",
          path: "src",
          reveal: true,
          threadId: undefined,
        }),
      );
      expect([root, file, reveal].every(Exit.isSuccess)).toBe(true);
      expect(calls.open).toEqual([
        { projectId: PROJECT, editor: "cursor" },
        { projectId: PROJECT, threadId: THREAD, editor: "cursor", path: "src/index.ts", line: 12 },
        { projectId: PROJECT, editor: "finder", path: "src", reveal: true },
      ]);
    }),
  );

  it.live("an open resolves with the server's refusal", () =>
    Effect.gen(function* () {
      const { registry, openIn } = yield* runtimeWith(CONNECTED);
      const exit = yield* Effect.promise(() =>
        openIn(registry, { projectId: PROJECT, editor: "cursor", path: "../outside" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit) ? exit.cause : null;
      expect(JSON.stringify(error)).toContain("Outside the workspace.");
    }),
  );
});
