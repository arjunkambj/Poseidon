/**
 * Who writes generated text: the chosen Writing model while it is open,
 * switched on and able to write; otherwise Same as the thread, with a notice
 * when a chosen model had to be passed over; the routed default when there is
 * no thread; `unavailable` when no open instance can write.
 */

import { describe, expect, it } from "@effect/vitest";
import type { ConnectorInstance, ConnectorServices } from "@poseidon/connector-sdk/definition";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import { DEFAULT_GENERATION_SETTINGS } from "@poseidon/contracts/generation";
import type { GenerationSettings } from "@poseidon/contracts/generation";
import { DEFAULT_MODEL_PICKER_SETTINGS } from "@poseidon/contracts/settings";
import type { ModelPickerSettings } from "@poseidon/contracts/settings";
import { makeFakeConnector } from "@poseidon/testkit/fakeConnector";
import * as Effect from "effect/Effect";

import {
  NO_WRITER_MESSAGE,
  WRITER_FALLBACK_NOTICE,
  resolveWriter,
  type WriterDeps,
  type WriterPick,
  type WriterThread,
} from "./resolveWriter";

const services: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("prompt" as const) },
    attachmentsDir: "/tmp/poseidon-resolve-writer-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

const MODELS: ReadonlyArray<ModelOption> = [
  { id: "fast", label: "Fast", family: "f", efforts: ["low", "medium", "high"] },
  { id: "plain", label: "Plain", family: "f", efforts: [] },
  { id: "secret", label: "Secret", family: "f", efforts: ["low"], hidden: true },
];

/** An open instance; `writes` says whether it has `generateText`. */
const openInstance = (writes: boolean) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeConnector({
      models: MODELS,
      ...(writes ? { generateText: () => Effect.succeed("text") } : {}),
    });
    return yield* fake.definition.createInstance({
      instanceId: makeConnectorInstanceId(),
      config: {},
      services: yield* services,
    });
  });

const depsOf = (
  instances: ReadonlyArray<ConnectorInstance>,
  routed: WriterPick | null = null,
): WriterDeps => ({
  instance: (instanceId) =>
    Effect.succeed(instances.find((instance) => instance.instanceId === instanceId) ?? null),
  models: (instanceId) =>
    Effect.succeed(instances.some((instance) => instance.instanceId === instanceId) ? MODELS : []),
  routed: Effect.succeed(routed),
});

const settingsOf = (
  generation: Partial<GenerationSettings>,
  modelPicker: ModelPickerSettings = DEFAULT_MODEL_PICKER_SETTINGS,
) => ({ generation: { ...DEFAULT_GENERATION_SETTINGS, ...generation }, modelPicker });

const threadOn = (instanceId: ConnectorInstanceId | undefined, model = "plain"): WriterThread => ({
  settings: { model, ...(instanceId === undefined ? {} : { connectorInstanceId: instanceId }) },
  session: null,
});

const summary = (writer: {
  readonly instance: ConnectorInstance;
  readonly model: string;
  readonly effort?: string;
  readonly notice?: string;
}) => ({
  instanceId: writer.instance.instanceId,
  model: writer.model,
  effort: writer.effort,
  notice: writer.notice,
});

describe("resolveWriter", () => {
  it.effect("uses the chosen writing model, with its effort when the model takes it", () =>
    Effect.gen(function* () {
      const thread = yield* openInstance(true);
      const chosen = yield* openInstance(true);
      const deps = depsOf([thread, chosen]);
      const pick = { connectorInstanceId: chosen.instanceId, model: "fast" };

      const writer = yield* resolveWriter(
        settingsOf({ writingModel: pick, writingEffort: "medium" }),
        threadOn(thread.instanceId),
        deps,
      );
      expect(summary(writer)).toEqual({
        instanceId: chosen.instanceId,
        model: "fast",
        effort: "medium",
        notice: undefined,
      });

      // A model that lists no effort is sent none.
      const plain = yield* resolveWriter(
        settingsOf({ writingModel: { ...pick, model: "plain" } }),
        threadOn(thread.instanceId),
        deps,
      );
      expect(plain.effort).toBeUndefined();
    }),
  );

  it.effect("falls back to the thread, with a notice, when the chosen model cannot be used", () =>
    Effect.gen(function* () {
      const thread = yield* openInstance(true);
      const chosen = yield* openInstance(true);
      const mute = yield* openInstance(false);
      const deps = depsOf([thread, chosen, mute]);
      const onThread = threadOn(thread.instanceId, "fast");
      const expected = {
        instanceId: thread.instanceId,
        model: "fast",
        effort: "low",
        notice: WRITER_FALLBACK_NOTICE,
      };
      const cases: ReadonlyArray<readonly [string, ReturnType<typeof settingsOf>]> = [
        [
          "harness switched off",
          settingsOf(
            { writingModel: { connectorInstanceId: chosen.instanceId, model: "fast" } },
            { harnesses: { [chosen.instanceId]: false }, models: {} },
          ),
        ],
        [
          "model switched off",
          settingsOf(
            { writingModel: { connectorInstanceId: chosen.instanceId, model: "fast" } },
            { harnesses: {}, models: { [chosen.instanceId]: { fast: false } } },
          ),
        ],
        [
          "model hidden by its connector",
          settingsOf({ writingModel: { connectorInstanceId: chosen.instanceId, model: "secret" } }),
        ],
        [
          "model gone",
          settingsOf({ writingModel: { connectorInstanceId: chosen.instanceId, model: "gone" } }),
        ],
        [
          "instance gone",
          settingsOf({
            writingModel: { connectorInstanceId: makeConnectorInstanceId(), model: "fast" },
          }),
        ],
        [
          "instance cannot write",
          settingsOf({ writingModel: { connectorInstanceId: mute.instanceId, model: "fast" } }),
        ],
      ];
      for (const [label, settings] of cases) {
        const writer = yield* resolveWriter(settings, onThread, deps);
        expect({ label, ...summary(writer) }).toEqual({ label, ...expected });
      }

      // A hidden model the user switched on is theirs to write with.
      const shown = yield* resolveWriter(
        settingsOf(
          { writingModel: { connectorInstanceId: chosen.instanceId, model: "secret" } },
          { harnesses: {}, models: { [chosen.instanceId]: { secret: true } } },
        ),
        onThread,
        deps,
      );
      expect(summary(shown).instanceId).toBe(chosen.instanceId);
    }),
  );

  it.effect("same as the thread reads its instance, then its session's, then routing", () =>
    Effect.gen(function* () {
      const own = yield* openInstance(true);
      const routed = yield* openInstance(true);
      const deps = depsOf([own, routed], { connectorInstanceId: routed.instanceId, model: "fast" });

      const chosen = yield* resolveWriter(settingsOf({}), threadOn(own.instanceId), deps);
      expect(summary(chosen)).toMatchObject({ instanceId: own.instanceId, model: "plain" });

      const bound = yield* resolveWriter(
        settingsOf({}),
        { settings: { model: "fast" }, session: { connectorInstanceId: own.instanceId } },
        deps,
      );
      expect(summary(bound)).toMatchObject({ instanceId: own.instanceId, model: "fast" });

      const unbound = yield* resolveWriter(settingsOf({}), threadOn(undefined, "fast"), deps);
      expect(summary(unbound)).toMatchObject({ instanceId: routed.instanceId, model: "fast" });
    }),
  );

  it.effect("with no thread the routed default writes", () =>
    Effect.gen(function* () {
      const routed = yield* openInstance(true);
      const deps = depsOf([routed], { connectorInstanceId: routed.instanceId, model: "fast" });
      const writer = yield* resolveWriter(settingsOf({}), null, deps);
      expect(summary(writer)).toEqual({
        instanceId: routed.instanceId,
        model: "fast",
        effort: "low",
        notice: undefined,
      });
    }),
  );

  it.effect("a thread whose harness cannot write falls through to the routed default", () =>
    Effect.gen(function* () {
      const mute = yield* openInstance(false);
      const routed = yield* openInstance(true);
      const deps = depsOf([mute, routed], {
        connectorInstanceId: routed.instanceId,
        model: "fast",
      });
      const writer = yield* resolveWriter(settingsOf({}), threadOn(mute.instanceId), deps);
      expect(writer.instance.instanceId).toBe(routed.instanceId);
    }),
  );

  it.effect("answers unavailable when no open instance can write", () =>
    Effect.gen(function* () {
      const mute = yield* openInstance(false);
      const deps = depsOf([mute], { connectorInstanceId: mute.instanceId, model: "fast" });
      const error = yield* Effect.flip(
        resolveWriter(
          settingsOf({ writingModel: { connectorInstanceId: mute.instanceId, model: "fast" } }),
          threadOn(mute.instanceId),
          deps,
        ),
      );
      expect(error).toBeInstanceOf(PoseidonRpcError);
      expect(error).toMatchObject({ code: "unavailable", message: NO_WRITER_MESSAGE });

      const none = yield* Effect.flip(resolveWriter(settingsOf({}), null, depsOf([])));
      expect(none.code).toBe("unavailable");
    }),
  );
});
