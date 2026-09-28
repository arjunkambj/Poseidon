/**
 * The generated-text calls over a stubbed RPC client. What the dialogs and the
 * thread menus rely on: each call sends the payload the server expects, a
 * refusal comes back as the call's own failure, and aborting the signal
 * interrupts the call on the server — which is what stops the harness.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
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
import { makeGenerationCommands } from "./generationCommands";

interface Calls {
  readonly commit: Array<unknown>;
  readonly pullRequest: Array<unknown>;
  readonly title: Array<unknown>;
  /** Calls cut short before they answered. */
  readonly interrupted: Array<string>;
}

/** A pull request call waits for `gate`, so a test can abort it mid-flight. */
const fakeClient = (
  calls: Calls,
  gate: Deferred.Deferred<void>,
  refuse: boolean,
): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "git.generateCommitMessage":
          return (payload: unknown) =>
            refuse
              ? Effect.fail(
                  new PoseidonRpcError({
                    code: "unavailable",
                    message: "No harness that can write text is available.",
                  }),
                )
              : Effect.sync(() => {
                  calls.commit.push(payload);
                  return { subject: "Fix the login redirect", body: "- Keep the next param" };
                });
        case "git.generatePullRequest":
          return (payload: unknown) =>
            Effect.gen(function* () {
              calls.pullRequest.push(payload);
              yield* Deferred.await(gate);
              return { title: "Fix the login redirect", body: "## Summary" };
            }).pipe(
              Effect.onInterrupt(() => Effect.sync(() => calls.interrupted.push("pull-request"))),
            );
        case "thread.regenerateTitle":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.title.push(payload);
              return { title: "Login redirect fix", notice: "Used the thread's model." };
            });
        default:
          return () => Effect.die(`unimplemented rpc ${String(key)}`);
      }
    },
  });

const setupWith = (refuse = false) =>
  Effect.gen(function* () {
    const calls: Calls = { commit: [], pullRequest: [], title: [], interrupted: [] };
    const gate = yield* Deferred.make<void>();
    const stateRef = yield* SubscriptionRef.make<ConnectionState>({
      status: "connected",
      serverInstanceId: null,
    });
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, {
        client: Effect.succeed(fakeClient(calls, gate, refuse)),
        state: stateRef,
      }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const { runtime } = makeRuntime(layer);
    return { calls, gate, registry: AtomRegistry.make(), ...makeGenerationCommands(runtime) };
  });

describe("generation commands", () => {
  it.live("a commit message sends the scope and the ticked paths", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const { calls, registry, generateCommitMessage } = yield* setupWith();

      const ticked = yield* Effect.promise(() =>
        generateCommitMessage(registry, { projectId, threadId, paths: ["src/a.ts"] }),
      );
      const all = yield* Effect.promise(() => generateCommitMessage(registry, { projectId }));

      expect(Exit.isSuccess(ticked) && ticked.value.subject).toBe("Fix the login redirect");
      expect(Exit.isSuccess(all)).toBe(true);
      // No `paths` and no `threadId` on the wire when they are absent.
      expect(calls.commit).toEqual([{ projectId, threadId, paths: ["src/a.ts"] }, { projectId }]);
    }),
  );

  it.live("a refusal is the call's own failure", () =>
    Effect.gen(function* () {
      const { registry, generateCommitMessage } = yield* setupWith(true);
      const exit = yield* Effect.promise(() =>
        generateCommitMessage(registry, { projectId: makeProjectId() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("aborting the signal interrupts the call on the server", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, registry, generatePullRequest } = yield* setupWith();
      const controller = new AbortController();

      const pending = generatePullRequest(registry, { projectId }, { signal: controller.signal });
      yield* Effect.promise(() => expect.poll(() => calls.pullRequest.length).toBe(1));
      controller.abort();
      const exit = yield* Effect.promise(() => pending);

      expect(Exit.isSuccess(exit)).toBe(false);
      expect(calls.pullRequest).toEqual([{ projectId }]);
      yield* Effect.promise(() => expect.poll(() => calls.interrupted).toEqual(["pull-request"]));
    }),
  );

  it.live("a regenerated title sends the thread and carries the notice", () =>
    Effect.gen(function* () {
      const threadId = makeThreadId();
      const { calls, registry, regenerateTitle } = yield* setupWith();
      const exit = yield* Effect.promise(() => regenerateTitle(registry, { threadId }));
      expect(Exit.isSuccess(exit) && exit.value).toEqual({
        title: "Login redirect fix",
        notice: "Used the thread's model.",
      });
      expect(calls.title).toEqual([{ threadId }]);
    }),
  );
});
