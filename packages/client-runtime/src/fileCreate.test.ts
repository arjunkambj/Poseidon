/**
 * `createFile` over a stubbed RPC client: it sends the scope, path and text it
 * was given — the thread's id only when there is one — and resolves with the
 * server's answer, or with its refusal as a failed `Exit` the caller shows.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
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
import { makeFileAtoms } from "./fileAtoms";

interface CreateCall {
  readonly projectId: string;
  readonly threadId?: string;
  readonly path: string;
  readonly content: string;
}

/** A workspace that already holds `plan.md` and takes any other new path. */
const fakeClient = (calls: Array<CreateCall>): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) =>
      key === "files.create"
        ? (payload: CreateCall) =>
            Effect.suspend(() => {
              calls.push({ ...payload });
              return payload.path === "plan.md"
                ? Effect.fail(
                    new PoseidonRpcError({ code: "conflict", message: "plan.md already exists" }),
                  )
                : Effect.succeed({ path: payload.path });
            })
        : () => Effect.die(`unimplemented rpc ${String(key)}`),
  });

const setup = (calls: Array<CreateCall>) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make<ConnectionState>({
      status: "connected",
      serverInstanceId: null,
    });
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(fakeClient(calls)), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    return { registry: AtomRegistry.make(), ...makeFileAtoms(makeRuntime(layer).runtime) };
  });

describe("createFile", () => {
  it.live("sends the path and text, and resolves with where the file went", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const calls: Array<CreateCall> = [];
      const { registry, createFile } = yield* setup(calls);

      const local = yield* Effect.promise(() =>
        createFile(registry, { projectId, path: "docs/plan-a.md", content: "# A\n" }),
      );
      const inThread = yield* Effect.promise(() =>
        createFile(registry, { projectId, threadId, path: "b.md", content: "# B\n" }),
      );
      expect(Exit.isSuccess(local) && local.value).toEqual({ path: "docs/plan-a.md" });
      expect(Exit.isSuccess(inThread) && inThread.value).toEqual({ path: "b.md" });
      expect(calls).toEqual([
        { projectId, path: "docs/plan-a.md", content: "# A\n" },
        { projectId, threadId, path: "b.md", content: "# B\n" },
      ]);
    }),
  );

  it.live("resolves with the server's refusal when the file exists", () =>
    Effect.gen(function* () {
      const calls: Array<CreateCall> = [];
      const { registry, createFile } = yield* setup(calls);
      const exit = yield* Effect.promise(() =>
        createFile(registry, { projectId: makeProjectId(), path: "plan.md", content: "x" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("plan.md already exists");
    }),
  );
});
