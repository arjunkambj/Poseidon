/**
 * The one-shot thread writes over a stubbed RPC client. What a background
 * start relies on: a dispatch still waiting for the server is not cut short
 * by the next one, each caller gets its own receipt, and staging sends the
 * payload the server expects.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeCommandId, makeThreadId } from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/unstable/reactivity";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";
import { makeOneShotCommands } from "./oneShotCommands";

/** A rename to this title waits for `gate` before the server answers. */
const SLOW = "slow";

interface Calls {
  readonly dispatch: Array<Command>;
  readonly stage: Array<unknown>;
  /** Calls cut short before they answered. */
  readonly interrupted: Array<Command>;
}

const fakeClient = (calls: Calls, gate: Deferred.Deferred<void>): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "orchestration.dispatch":
          return ({ command }: { readonly command: Command }) =>
            Effect.gen(function* () {
              calls.dispatch.push(command);
              if (command.type === "thread.rename" && command.title === SLOW) {
                yield* Deferred.await(gate);
              }
              return {
                commandId: command.commandId,
                status: "accepted" as const,
                lastSequence: calls.dispatch.length,
              };
            }).pipe(Effect.onInterrupt(() => Effect.sync(() => calls.interrupted.push(command))));
        case "attachments.stage":
          return (payload: { readonly name: string }) =>
            Effect.sync(() => {
              calls.stage.push(payload);
              return {
                path: `attachments/${payload.name}`,
                name: payload.name,
                mime: "image/png",
                size: 4,
                sha256: "0f1e2d",
              };
            });
        default:
          return () => Effect.die(`unimplemented rpc ${String(key)}`);
      }
    },
  });

const setupWith = Effect.gen(function* () {
  const calls: Calls = { dispatch: [], stage: [], interrupted: [] };
  const gate = yield* Deferred.make<void>();
  const stateRef = yield* SubscriptionRef.make<ConnectionState>({
    status: "connected",
    serverInstanceId: null,
  });
  const layer = Layer.mergeAll(
    Layer.succeed(Connection, { client: Effect.succeed(fakeClient(calls, gate)), state: stateRef }),
    Layer.succeed(ConnectionStateRef, stateRef),
  );
  const { runtime } = makeRuntime(layer);
  return { calls, gate, registry: AtomRegistry.make(), ...makeOneShotCommands(runtime) };
});

const rename = (title: string): Command => ({
  commandId: makeCommandId(),
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "thread.rename",
  threadId: makeThreadId(),
  title,
});

describe("one-shot commands", () => {
  it.live("overlapping dispatches each resolve with their own receipt", () =>
    Effect.gen(function* () {
      const { calls, gate, registry, dispatch } = yield* setupWith;
      const slow = rename(SLOW);
      const fast = rename("Fix the login");

      // One lane's command is still in flight when the next one is sent.
      const first = dispatch(registry, slow);
      yield* Effect.promise(() => expect.poll(() => calls.dispatch.length).toBe(1));
      const second = yield* Effect.promise(() => dispatch(registry, fast));
      expect(Exit.isSuccess(second) && second.value.commandId).toBe(fast.commandId);

      yield* Deferred.succeed(gate, undefined);
      const settled = yield* Effect.promise(() => first);
      expect(Exit.isSuccess(settled) && settled.value.commandId).toBe(slow.commandId);
      expect(calls.interrupted).toEqual([]);
    }),
  );

  it.live("staging sends the thread, name and bytes and resolves with the reference", () =>
    Effect.gen(function* () {
      const threadId = makeThreadId();
      const { calls, registry, stageAttachment } = yield* setupWith;
      const [one, two] = yield* Effect.promise(() =>
        Promise.all([
          stageAttachment(registry, { threadId, name: "one.png", base64: "AAAA" }),
          stageAttachment(registry, { threadId, name: "two.png", base64: "BBBB" }),
        ]),
      );
      expect(Exit.isSuccess(one) && one.value.path).toBe("attachments/one.png");
      expect(Exit.isSuccess(two) && two.value.path).toBe("attachments/two.png");
      expect(calls.stage).toEqual([
        { threadId, name: "one.png", base64: "AAAA" },
        { threadId, name: "two.png", base64: "BBBB" },
      ]);
    }),
  );
});
