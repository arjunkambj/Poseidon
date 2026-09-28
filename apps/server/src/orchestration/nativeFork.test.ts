/**
 * A fork the harness makes itself, end to end through the real engine,
 * reactors and session manager. The connector is the testkit's fake, wrapped
 * at the SDK boundary to declare `fork` and to record what `resumeSession`
 * was asked for — what a harness does with `fork: true` is the connector's
 * business, and `connector-cmd` replays a real recording of it.
 */

import { describe, expect, it } from "@effect/vitest";
import {
  makeCommandId,
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
} from "@poseidon/contracts/ids";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { Command, OrchestrationEvent } from "@poseidon/contracts/orchestration";
import type {
  ConnectorInstance,
  ConnectorServices,
  ResumeSessionInput,
} from "@poseidon/connector-sdk/definition";
import { SpawnFailed } from "@poseidon/connector-sdk/definition";
import { makeFakeConnector, type FakeConnector } from "@poseidon/testkit/fakeConnector";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { OrchestrationEngine } from "./Engine";
import { stackLayer } from "../../test/layers";

const NOW = "2026-01-02T03:04:05.000Z";

const services = Effect.clockWith((clock) =>
  Effect.succeed<ConnectorServices>({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("allow" as const) },
    attachmentsDir: "/tmp/poseidon-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

/**
 * A fake instance whose harness can fork. Every `resumeSession` input is
 * kept; with `refuseFork` a forking resume fails the way a connector that
 * cannot fork the ref does.
 */
const openForkable = (refuseFork: boolean) =>
  Effect.gen(function* () {
    const fake: FakeConnector = yield* makeFakeConnector({ capabilities: { fork: true } });
    const inner = yield* fake.definition.createInstance({
      instanceId: makeConnectorInstanceId(),
      config: {},
      services: yield* services,
    });
    const resumes: Array<ResumeSessionInput> = [];
    const instance: ConnectorInstance = {
      ...inner,
      resumeSession: (input) => {
        resumes.push(input);
        return refuseFork && input.fork === true
          ? Effect.fail(
              new SpawnFailed({ kind: inner.kind, instanceId: inner.instanceId, message: "gone" }),
            )
          : inner.resumeSession(input);
      },
    };
    return { fake, instance, resumes };
  });

const projectId = makeProjectId();

const command = (fields: Record<string, unknown>): Command =>
  ({ commandId: makeCommandId(), createdAt: NOW, ...fields }) as Command;

const turnStart = (threadId: ThreadId, text: string) =>
  command({
    type: "thread.turn.start",
    threadId,
    text,
    attachments: [],
    mentions: [],
    queued: false,
  });

/** Starts a turn on `threadId` and waits for it to complete. */
const runTurn = (engine: OrchestrationEngine["Service"], threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const mailbox = yield* engine.subscribeEvents;
    const done = yield* Stream.fromSubscription(mailbox).pipe(
      Stream.filter(
        (event: OrchestrationEvent) =>
          event.type === "thread.turn.completed" && event.streamId === threadId,
      ),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* engine.dispatch(turnStart(threadId, text));
    yield* Fiber.join(done);
  });

/**
 * A source thread with two settled turns, then a fork of it made from
 * `through` ("latest" or "earlier"), which runs one turn of its own. Returns
 * what the fork's session was sent and how it was opened.
 */
const forkAndRun = (options: {
  readonly through: "latest" | "earlier";
  readonly refuseFork?: boolean;
  /** Runs one more source turn after the fork is made, before its first. */
  readonly sourceMovesOn?: boolean;
}) =>
  Effect.gen(function* () {
    const { fake, instance, resumes } = yield* openForkable(options.refuseFork ?? false);
    const sourceId = makeThreadId();
    const forkId = makeThreadId();
    const recorded = yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(
        command({ type: "project.create", projectId, name: "demo", workspaceRoot: "/repo" }),
      );
      yield* engine.dispatch(
        command({
          type: "thread.create",
          threadId: sourceId,
          projectId,
          settings: { model: "fake/model" },
        }),
      );
      yield* runTurn(engine, sourceId, "hello");
      yield* runTurn(engine, sourceId, "again");
      const source = (yield* engine.threadDoc(sourceId))!;
      const asks = source.items.filter((item) => item.kind === "user_message");
      const through = options.through === "latest" ? asks.at(-1)! : asks[0]!;

      const receipt = yield* engine.dispatch(
        command({
          type: "thread.create",
          threadId: forkId,
          projectId,
          fork: { threadId: sourceId, throughItemId: through.itemId },
        }),
      );
      expect(receipt.status).toBe("accepted");
      const forked = (yield* engine.threadDoc(forkId))!;
      if (options.sourceMovesOn === true) {
        yield* runTurn(engine, sourceId, "meanwhile");
      }
      yield* runTurn(engine, forkId, "and now?");
      return { sourceRef: source.session?.sessionRef, forked };
    }).pipe(Effect.provide(stackLayer({ instance })));

    const session = yield* fake.session(forkId);
    const sent = (yield* session!.calls)
      .filter((call) => call.method === "send")
      .map((call) => call.detail.text as string);
    return {
      ...recorded,
      sent,
      forkResumes: resumes.filter((input) => input.threadId === forkId),
    };
  });

describe("a fork the harness makes itself", () => {
  it.effect("resumes the source's session with fork, and sends only what was typed", () =>
    Effect.gen(function* () {
      const { sourceRef, forked, sent, forkResumes } = yield* forkAndRun({ through: "latest" });
      expect(sourceRef).toBeDefined();
      expect((forked.fork as { session?: unknown }).session).toMatchObject({
        sessionRef: sourceRef,
      });
      expect(forkResumes).toHaveLength(1);
      expect(forkResumes[0]).toMatchObject({ fork: true, sessionRef: sourceRef });
      expect(sent).toEqual(["and now?"]);
    }),
  );

  it.effect("starts fresh with the transcript when the harness cannot fork after all", () =>
    Effect.gen(function* () {
      const { sent, forkResumes } = yield* forkAndRun({ through: "latest", refuseFork: true });
      expect(forkResumes.map((input) => input.fork)).toEqual([true]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("User:\nhello");
      expect(sent[0]!.endsWith("The user's new message:\n\nand now?")).toBe(true);
    }),
  );

  it.effect("copies instead when the source ran another turn before the fork's first", () =>
    Effect.gen(function* () {
      const { forked, sent, forkResumes } = yield* forkAndRun({
        through: "latest",
        sourceMovesOn: true,
      });
      expect((forked.fork as { session?: unknown }).session).toBeDefined();
      expect(forkResumes).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("User:\nagain");
      expect(sent[0]).not.toContain("meanwhile");
      expect(sent[0]!.endsWith("The user's new message:\n\nand now?")).toBe(true);
    }),
  );

  it.effect("copies a fork of an earlier turn, as for any harness", () =>
    Effect.gen(function* () {
      const { forked, sent, forkResumes } = yield* forkAndRun({ through: "earlier" });
      expect((forked.fork as { session?: unknown }).session).toBeUndefined();
      expect(forkResumes).toEqual([]);
      expect(sent[0]).toContain("User:\nhello");
      expect(sent[0]).not.toContain("User:\nagain");
    }),
  );
});
