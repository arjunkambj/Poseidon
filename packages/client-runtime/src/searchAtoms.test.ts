/**
 * The message-search atom over a stubbed RPC client. What the palette depends
 * on and cannot get from the server: a short query answers empty without a
 * call, hits and failures both arrive as values, each query is its own atom,
 * and dropping a query's atom cancels its call.
 */

import { describe, expect, it } from "@effect/vitest";
import type { ItemId, ProjectId, ThreadId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import type { MessageSearchHit } from "@poseidon/contracts/search";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";
import { isSearchableQuery, makeSearchAtoms, type MessageSearchQuery } from "./searchAtoms";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };

const hit: MessageSearchHit = {
  threadId: "018f2b6e-1c2d-7a3b-8c4d-5e6f7a8b9c0d" as ThreadId,
  projectId: "018f2b6e-1c2d-7a3b-8c4d-5e6f7a8b9c0e" as ProjectId,
  title: "Fix the lantern",
  archived: false,
  itemId: "018f2b6e-1c2d-7a3b-8c4d-5e6f7a8b9c0f" as ItemId,
  role: "user",
  snippet: "why does the lantern flicker",
};

type Answer = "hits" | "refused" | "hang";

interface Fake {
  readonly calls: Array<string>;
  readonly answer: Ref.Ref<Answer>;
  /** Completed when a hanging call starts, and when it is interrupted. */
  readonly started: Deferred.Deferred<void>;
  readonly interrupted: Deferred.Deferred<void>;
}

const fakeClient = (fake: Fake): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      if (key === "threads.searchMessages") {
        return (payload: { query: string }) =>
          Effect.gen(function* () {
            fake.calls.push(payload.query);
            const answer = yield* Ref.get(fake.answer);
            if (answer === "refused") {
              return yield* Effect.fail(
                new PoseidonRpcError({ code: "unavailable", message: "Search is warming up." }),
              );
            }
            if (answer === "hang") {
              yield* Deferred.succeed(fake.started, undefined);
              return yield* Effect.never.pipe(
                Effect.onInterrupt(() => Deferred.succeed(fake.interrupted, undefined)),
              );
            }
            return [hit];
          });
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const setup = (answer: Answer) =>
  Effect.gen(function* () {
    const fake: Fake = {
      calls: [],
      answer: yield* Ref.make(answer),
      started: yield* Deferred.make<void>(),
      interrupted: yield* Deferred.make<void>(),
    };
    const stateRef = yield* SubscriptionRef.make(CONNECTED);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(fakeClient(fake)), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    return { fake, registry: AtomRegistry.make(), ...makeSearchAtoms(base.runtime) };
  });

type SearchAtom = Atom.Atom<AsyncResult.AsyncResult<MessageSearchQuery, Cause.NoSuchElementError>>;

/** Resolves on the atom's first value — no timers in logic. */
const firstValue = (
  registry: AtomRegistry.AtomRegistry,
  atom: SearchAtom,
): Promise<MessageSearchQuery> =>
  new Promise((resolve) => {
    const check = (
      result: AsyncResult.AsyncResult<MessageSearchQuery, Cause.NoSuchElementError>,
    ) => {
      if (AsyncResult.isSuccess(result)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("message search atom", () => {
  it("counts characters, not blanks or UTF-16 units, against the minimum", () => {
    expect(isSearchableQuery("ab")).toBe(false);
    expect(isSearchableQuery("  ab  ")).toBe(false);
    expect(isSearchableQuery("🔥🔥")).toBe(false);
    expect(isSearchableQuery("abc")).toBe(true);
  });

  it.live("answers a short query with no hits and never asks the server", () =>
    Effect.gen(function* () {
      const { fake, registry, messageSearchAtom } = yield* setup("hits");
      const answer = yield* Effect.promise(() => firstValue(registry, messageSearchAtom(" ab ")));
      expect(answer).toEqual({ _tag: "ok", hits: [] });
      expect(fake.calls).toEqual([]);
    }),
  );

  it.live("carries the server's hits for a long enough query, trimmed", () =>
    Effect.gen(function* () {
      const { fake, registry, messageSearchAtom } = yield* setup("hits");
      const answer = yield* Effect.promise(() =>
        firstValue(registry, messageSearchAtom(" lantern ")),
      );
      expect(answer).toEqual({ _tag: "ok", hits: [hit] });
      expect(fake.calls).toEqual(["lantern"]);
    }),
  );

  it.live("turns a refusal into a value that keeps the server's words", () =>
    Effect.gen(function* () {
      const { registry, messageSearchAtom } = yield* setup("refused");
      const answer = yield* Effect.promise(() =>
        firstValue(registry, messageSearchAtom("lantern")),
      );
      expect(answer).toEqual({ _tag: "error", message: "Search is warming up." });
    }),
  );

  it.live("gives each query its own atom and cancels the call of one no longer read", () =>
    Effect.gen(function* () {
      const { fake, registry, messageSearchAtom } = yield* setup("hang");
      expect(messageSearchAtom("lantern")).toBe(messageSearchAtom("lantern"));
      expect(messageSearchAtom("lantern")).not.toBe(messageSearchAtom("lanterns"));

      const unmount = registry.mount(messageSearchAtom("lan"));
      yield* Deferred.await(fake.started).pipe(Effect.timeout("2 seconds"));
      expect(fake.calls).toEqual(["lan"]);

      // The palette moves on to the next keystroke's atom; the old call stops.
      unmount();
      yield* Deferred.await(fake.interrupted).pipe(Effect.timeout("2 seconds"));
    }),
  );
});
