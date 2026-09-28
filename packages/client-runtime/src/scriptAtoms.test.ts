/**
 * The detected-scripts atoms over a stubbed RPC client: nothing is asked
 * offline, a mount asks once for its own scope, a failed call is the empty
 * list, and the family key round-trips.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import type { DetectedScript } from "@poseidon/contracts/scripts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";
import { decodeScriptScope, encodeScriptScope, makeScriptAtoms } from "./scriptAtoms";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

const SCRIPTS: ReadonlyArray<DetectedScript> = [
  {
    id: "pkg::dev",
    name: "dev",
    packageName: "acme",
    packageDir: "",
    command: "pnpm run dev",
    packageManager: "pnpm",
  },
];

const PROJECT = makeProjectId();
const THREAD = makeThreadId();

const runtimeWith = (initial: ConnectionState, failing = false) =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const stateRef = yield* SubscriptionRef.make(initial);
    const client = new Proxy({} as PoseidonRpcClient, {
      get: (_target, key) =>
        key === "scripts.detect"
          ? (payload: unknown) =>
              Effect.suspend(() => {
                calls.push(payload);
                return failing
                  ? Effect.fail(new PoseidonRpcError({ code: "not-found", message: "gone" }))
                  : Effect.succeed(SCRIPTS);
              })
          : () => Effect.die(`unimplemented rpc ${String(key)}`),
    });
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    return { calls, registry: AtomRegistry.make(), ...makeScriptAtoms(makeRuntime(layer).runtime) };
  });

type Listing = AsyncResult.AsyncResult<ReadonlyArray<DetectedScript>, unknown>;

const awaitListing = (
  registry: AtomRegistry.AtomRegistry,
  atom: ReturnType<ReturnType<typeof makeScriptAtoms>["detectedScriptsAtom"]>,
): Promise<ReadonlyArray<DetectedScript>> =>
  new Promise((resolve) => {
    const check = (result: Listing) => {
      if (AsyncResult.isSuccess(result)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("detected scripts atoms", () => {
  it("round-trips the family key", () => {
    expect(decodeScriptScope(encodeScriptScope({ projectId: PROJECT }))).toEqual({
      projectId: PROJECT,
    });
    expect(decodeScriptScope(encodeScriptScope({ projectId: PROJECT, threadId: THREAD }))).toEqual({
      projectId: PROJECT,
      threadId: THREAD,
    });
  });

  it.live("offline, asks nothing and stays Initial", () =>
    Effect.gen(function* () {
      const { calls, registry, detectedScriptsAtom } = yield* runtimeWith(RECONNECTING);
      const atom = detectedScriptsAtom({ projectId: PROJECT });
      registry.mount(atom);
      yield* Effect.yieldNow;
      expect(AsyncResult.isInitial(registry.get(atom))).toBe(true);
      expect(calls).toEqual([]);
    }),
  );

  it.live("asks once for the mounted scope", () =>
    Effect.gen(function* () {
      const { calls, registry, detectedScriptsAtom } = yield* runtimeWith(CONNECTED);
      const atom = detectedScriptsAtom({ projectId: PROJECT, threadId: THREAD });
      const listed = yield* Effect.promise(() => awaitListing(registry, atom));
      expect(listed).toEqual(SCRIPTS);
      expect(calls).toEqual([{ projectId: PROJECT, threadId: THREAD }]);
    }),
  );

  it.live("a failed call is the empty list", () =>
    Effect.gen(function* () {
      const { calls, registry, detectedScriptsAtom } = yield* runtimeWith(CONNECTED, true);
      const listed = yield* Effect.promise(() =>
        awaitListing(registry, detectedScriptsAtom({ projectId: PROJECT })),
      );
      expect(listed).toEqual([]);
      expect(calls).toEqual([{ projectId: PROJECT }]);
    }),
  );
});
