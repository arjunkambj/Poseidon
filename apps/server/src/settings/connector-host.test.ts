/**
 * The host façade is late-bound on purpose: the connector manager opens
 * instances while the layer graph is still being built, long before the hook
 * bridge or the permission ladder exist. These tests pin the two halves of
 * that contract — the safe behaviour before `install`, and that an instance
 * holding the *same* services object sees the real endpoints afterwards.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeRequestId, makeThreadId } from "@poseidon/contracts/ids";
import type { ApprovalRequest } from "@poseidon/contracts/runtime";
import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";
import { POSEIDON_HOME_ENV } from "@poseidon/shared/paths";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { ConnectorHost } from "./ConnectorHost";

const request: ApprovalRequest = {
  requestId: makeRequestId(),
  kind: "command",
  toolName: "Bash",
  input: {},
  description: "run something",
};

/**
 * `install` creates the attachments directory under `POSEIDON_HOME`, so every
 * host here gets a home of its own — a plain `vitest run` must never write into
 * the developer's real `~/.poseidon`.
 */
const hostWithHome = (prepare: (home: string) => void = () => {}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[POSEIDON_HOME_ENV];
      const home = mkdtempSync(join(tmpdir(), "poseidon-host-"));
      prepare(home);
      process.env[POSEIDON_HOME_ENV] = home;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env[POSEIDON_HOME_ENV];
        } else {
          process.env[POSEIDON_HOME_ENV] = previous;
        }
      }),
  ).pipe(
    Effect.andThen(
      Effect.map(Layer.build(ConnectorHost.layer), (ctx) => Context.get(ctx, ConnectorHost)),
    ),
  );

const host = hostWithHome();

describe("ConnectorHost", () => {
  it.effect("before install an endpoint is a defect and every decision is prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { services } = yield* host;
        const threadId = makeThreadId();

        const hook = yield* Effect.exit(services.hookEndpoint(threadId));
        expect(Exit.isFailure(hook)).toBe(true);
        const mcp = yield* Effect.exit(services.mcpEndpoint(threadId));
        expect(Exit.isFailure(mcp)).toBe(true);

        const decision = yield* services.permissions.decide({
          request,
          threadId,
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        expect(decision).toBe("prompt");
      }),
    ),
  );

  it.effect("an object taken before install answers from the installed endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* host;
        // Exactly what `registry.open` captured at open time.
        const { services } = service;
        const threadId = makeThreadId();

        yield* service.install({
          mcpEndpoint: (id) => Effect.succeed({ url: `http://mcp/${id}`, bearer: "m" }),
          hookEndpoint: (id) => Effect.succeed({ url: `http://hook/${id}`, bearer: "h" }),
          permissions: { decide: () => Effect.succeed("deny") },
        });

        expect(yield* services.hookEndpoint(threadId)).toEqual({
          url: `http://hook/${threadId}`,
          bearer: "h",
        });
        expect(yield* services.mcpEndpoint(threadId)).toEqual({
          url: `http://mcp/${threadId}`,
          bearer: "m",
        });
        expect(
          yield* services.permissions.decide({
            request,
            threadId,
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
        ).toBe("deny");
      }),
    ),
  );

  it.effect("sessionPlugins answers none before install and delegates after it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* host;
        const { services } = service;
        const threadId = makeThreadId();
        const plugin: SessionPlugin = {
          name: "browser",
          root: "/plugins/browser",
          builtin: true,
          skills: [{ name: "browser", path: "/plugins/browser/skills/browser" }],
          skillsDirs: ["/plugins/browser/skills"],
          mcpServers: [],
        };

        expect(yield* services.sessionPlugins!(threadId)).toEqual([]);

        const asked: Array<string> = [];
        yield* service.install({
          mcpEndpoint: (id) => Effect.succeed({ url: `http://mcp/${id}`, bearer: "m" }),
          hookEndpoint: (id) => Effect.succeed({ url: `http://hook/${id}`, bearer: "h" }),
          permissions: { decide: () => Effect.succeed("deny") },
          sessionPlugins: (id) =>
            Effect.sync(() => {
              asked.push(id);
              return [plugin];
            }),
        });

        expect(yield* services.sessionPlugins!(threadId)).toEqual([plugin]);
        expect(asked).toEqual([threadId]);
      }),
    ),
  );

  it.effect("a home that cannot hold the attachments directory still installs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // `install` sits on the boot's critical path, before the handshake, so
        // a `mkdir` that cannot succeed must degrade rather than take the
        // server down. A plain file where the directory belongs is the
        // cheapest way to make it reject, and the rejection arrives as a
        // defect — which is exactly what the old `Effect.ignore` let through.
        const service = yield* hostWithHome((home) =>
          writeFileSync(join(home, "attachments"), "not a directory"),
        );
        const threadId = makeThreadId();

        const exit = yield* Effect.exit(
          service.install({
            mcpEndpoint: (id) => Effect.succeed({ url: `http://mcp/${id}`, bearer: "m" }),
            hookEndpoint: (id) => Effect.succeed({ url: `http://hook/${id}`, bearer: "h" }),
            permissions: { decide: () => Effect.succeed("deny") },
          }),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        // And the endpoints it was given are live, so boot carries on.
        expect(yield* service.services.hookEndpoint(threadId)).toEqual({
          url: `http://hook/${threadId}`,
          bearer: "h",
        });
      }),
    ),
  );

  it.effect("registering a hook handler without a bridge is a warning, not a crash", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* host;
        const threadId = makeThreadId();
        // The connector branches on `undefined`, so the member must exist.
        expect(service.services.registerHookHandler).toBeDefined();
        yield* service.services.registerHookHandler!(threadId, () => Effect.succeed({}));
        yield* service.services.unregisterHookHandler!(threadId);
      }),
    ),
  );
});
