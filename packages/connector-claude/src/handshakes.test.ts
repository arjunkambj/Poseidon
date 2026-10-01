/**
 * The handshake answer the probe and the instances share, and the asking again
 * a provisional answer starts. The handshakes are scripted: what is under test
 * is which answer is kept and when the CLI is asked again, not the CLI.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { ModelOption } from "@poseidon/contracts/connectors";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { testServices } from "../test/services";
import { ASK_AGAIN_AFTER, LINGER, makeClaudeConnectorDefinition } from "./definition";
import { handshakeKey, makeHandshakes } from "./handshakes";
import type { Handshake, Initialization } from "./probe";

const row = (label: string, id = label): ModelOption => ({
  id,
  label,
  family: "Claude",
  efforts: [],
});

const answer = (
  labels: ReadonlyArray<string>,
  provisional: boolean,
  account: string | null = "user@example.com",
): Initialization => ({
  models: labels.map((label) => row(label)),
  commands: [],
  ...(account === null ? {} : { account }),
  signedIn: account !== null,
  provisional,
});

/** The CLI's compiled-in list, as a signed-in CLI answers before its catalog loads. */
const COMPILED = answer(["Default (Opus 5.5)", "Opus 5.5", "Sonnet 5.5"], true);
/** The account's catalog. */
const CATALOG = answer(
  ["Default (Opus 5.5)", "Opus 5.5", "Sonnet 5.5", "Opus 5", "Sonnet 5"],
  false,
);

/** Answers `answers` in turn and the last one ever after, noting how long each was asked to linger. */
const scripted = (answers: ReadonlyArray<Initialization>) => {
  const lingers: Array<Duration.Input | undefined> = [];
  const handshake: Handshake = (input) =>
    Effect.sync(() => {
      lingers.push(input.linger);
      return answers[Math.min(lingers.length - 1, answers.length - 1)]!;
    });
  return { handshake, lingers };
};

/**
 * A stand-in binary for the probe's two plain questions, answered signed in;
 * the handshake itself is scripted and starts nothing.
 */
const fakeClaude = (): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-handshakes-"));
  const path = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2.1.286 (Claude Code)"; exit 0; fi',
      `echo '{"loggedIn":true,"email":"user@example.com"}'`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
};

/** Lets forked fibers run up to their next sleep. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
});

const open = (handshake: Handshake, binaryPath = process.execPath) =>
  Effect.gen(function* () {
    const definition = makeClaudeConnectorDefinition({ handshake });
    const config = { binaryPath };
    const instance = yield* definition.createInstance({
      instanceId: makeConnectorInstanceId(),
      config,
      services: yield* testServices(),
    });
    return { definition, config, instance };
  });

describe("makeHandshakes", () => {
  it.effect("keeps a full answer over a provisional one, and any answer over nothing", () =>
    Effect.gen(function* () {
      const handshakes = makeHandshakes();
      const key = handshakeKey({});
      expect(yield* handshakes.record(key, COMPILED, "probe")).toBe(COMPILED);
      expect(yield* handshakes.record(key, CATALOG, "retry")).toBe(CATALOG);
      expect(yield* handshakes.record(key, COMPILED, "probe")).toBe(CATALOG);
      const smaller = answer(["Opus 5.5"], false);
      expect(yield* handshakes.record(key, smaller, "instance")).toBe(smaller);
      // Each configuration keeps its own.
      expect(yield* handshakes.record(handshakeKey({ configDir: "/x" }), COMPILED, "probe")).toBe(
        COMPILED,
      );
    }),
  );
});

describe("an answer from another account or sign-in state", () => {
  it.effect("replaces a full one even when provisional, and starts the asking again", () =>
    Effect.gen(function* () {
      // Signed out the compiled-in list is final; signing in brings a
      // compiled-in list again, then the new account's catalog.
      const signedOut = answer(
        ["Default (Opus 5.5, 1M context)", "Opus 5.5 (1M context)"],
        false,
        null,
      );
      const { handshake, lingers } = scripted([signedOut, COMPILED, CATALOG]);
      const { definition, config, instance } = yield* open(handshake, fakeClaude());
      expect(yield* instance.listModels()).toEqual(signedOut.models);
      expect((yield* definition.probe(config)).models).toEqual(COMPILED.models);
      expect(yield* instance.listModels()).toEqual(COMPILED.models);
      yield* settle;
      yield* TestClock.adjust(ASK_AGAIN_AFTER[0]!);
      yield* settle;
      expect(lingers).toEqual([undefined, undefined, LINGER]);
      expect(yield* instance.listModels()).toEqual(CATALOG.models);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps nothing of another account's list", () =>
    Effect.gen(function* () {
      const handshakes = makeHandshakes();
      const key = handshakeKey({});
      const fable = answer(["Fable 5.1 (1M context)"], true);
      yield* handshakes.record(key, fable, "probe");
      yield* handshakes.record(key, CATALOG, "retry");
      const other = answer(["Opus 5.5"], true, "other@example.com");
      expect(yield* handshakes.record(key, other, "probe")).toBe(other);
      const otherCatalog = answer(["Opus 5.5", "Sonnet 5"], false, "other@example.com");
      expect(yield* handshakes.record(key, otherCatalog, "retry")).toBe(otherCatalog);
    }),
  );
});

describe("a provisional model list", () => {
  it.effect("is asked about again until the catalog's list arrives, which is pushed", () =>
    Effect.gen(function* () {
      const { handshake, lingers } = scripted([COMPILED, COMPILED, CATALOG]);
      const { instance } = yield* open(handshake);
      const updates = yield* instance.modelUpdates!.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      expect(yield* instance.listModels()).toEqual(COMPILED.models);
      yield* settle;
      yield* TestClock.adjust(ASK_AGAIN_AFTER[0]!);
      yield* settle;
      // Still provisional: asked once more, and nothing new to push.
      expect(yield* instance.listModels()).toEqual(COMPILED.models);
      yield* TestClock.adjust(ASK_AGAIN_AFTER[1]!);
      yield* settle;
      expect(yield* instance.listModels()).toEqual(CATALOG.models);
      expect(Array.from(yield* Fiber.join(updates))).toEqual([COMPILED.models, CATALOG.models]);
      // The first ask is the picker's own; only the asking again lingers.
      expect(lingers).toEqual([undefined, LINGER, LINGER]);
      // Full now: no more asking.
      yield* TestClock.adjust("10 minutes");
      yield* settle;
      expect(lingers).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("is asked about a bounded number of times", () =>
    Effect.gen(function* () {
      const { handshake, lingers } = scripted([COMPILED]);
      const { instance } = yield* open(handshake);
      yield* instance.listModels();
      for (const delay of ASK_AGAIN_AFTER) {
        yield* settle;
        yield* TestClock.adjust(delay);
      }
      yield* settle;
      yield* TestClock.adjust("10 minutes");
      yield* settle;
      expect(lingers).toHaveLength(1 + ASK_AGAIN_AFTER.length);
      expect(yield* instance.listModels()).toEqual(COMPILED.models);
    }).pipe(Effect.scoped),
  );

  it.effect("from the probe starts the instance asking again too", () =>
    Effect.gen(function* () {
      const { handshake, lingers } = scripted([COMPILED, CATALOG]);
      const { definition, config, instance } = yield* open(handshake, fakeClaude());
      const probed = yield* definition.probe(config);
      expect(probed.models).toEqual(COMPILED.models);
      yield* settle;
      yield* TestClock.adjust(ASK_AGAIN_AFTER[0]!);
      yield* settle;
      // The instance never ran a handshake of its own before asking again.
      expect(lingers).toEqual([undefined, LINGER]);
      expect(yield* instance.listModels()).toEqual(CATALOG.models);
    }).pipe(Effect.scoped),
  );
});

describe("the probe and the instance", () => {
  it.effect("share one answer: a probe replaces the instance's, but never with a stand-in", () =>
    Effect.gen(function* () {
      const renamed = answer(["Default (Opus 5.5)", "Opus 5.5"], false);
      const { handshake } = scripted([CATALOG, COMPILED, renamed]);
      const { definition, config, instance } = yield* open(handshake, fakeClaude());
      expect(yield* instance.listModels()).toEqual(CATALOG.models);
      // A probe whose CLI fell back to its compiled-in list reports the full one.
      expect((yield* definition.probe(config)).models).toEqual(CATALOG.models);
      // A probe with a full list of its own replaces the instance's.
      expect((yield* definition.probe(config)).models).toEqual(renamed.models);
      expect(yield* instance.listModels()).toEqual(renamed.models);
    }).pipe(Effect.scoped),
  );
});
