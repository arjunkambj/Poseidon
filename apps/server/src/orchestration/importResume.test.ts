/**
 * An imported thread's first turn, end to end through the real engine,
 * reactors and session manager. The connector is the testkit's fake, wrapped
 * at the SDK boundary to record what `resumeSession` was asked for and, per
 * case, to refuse the resume or to start afresh in its place — what a harness
 * does with a session reference is the connector's business, and each
 * connector's own tests replay real recordings of it.
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
import type { SessionsExtension } from "@poseidon/connector-sdk/extensions";
import { makeFakeConnector } from "@poseidon/testkit/fakeConnector";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { transcriptEvents } from "../import/transcriptEvents";
import { EngineEnv, OrchestrationEngine } from "./Engine";
import { stackLayer } from "../../test/layers";

const NOW = "2026-01-02T03:04:05.000Z";
const SOURCE_ID = "harness-session";
const SOURCE_REF = { sessionId: SOURCE_ID };

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

/** How the wrapped instance answers a resume. */
type Resume = "resumes" | "refuses" | "starts-afresh";

/** Names a session by its `sessionId`, as the real readers do. */
const sessions: SessionsExtension = {
  list: () => Effect.succeed([]),
  read: () => Effect.die("not read here"),
  sourceIdOf: (ref) => (ref as { sessionId?: string } | undefined)?.sessionId,
};

const openInstance = (resume: Resume, canResume = true) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeConnector({
      capabilities: { resume: canResume },
      extensions: { sessions },
    });
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
        return resume === "refuses"
          ? Effect.fail(
              new SpawnFailed({ kind: inner.kind, instanceId: inner.instanceId, message: "gone" }),
            )
          : resume === "starts-afresh"
            ? inner.startSession(input)
            : inner.resumeSession(input);
      },
    };
    return { fake, instance, resumes };
  });

const command = (fields: Record<string, unknown>): Command =>
  ({ commandId: makeCommandId(), createdAt: NOW, ...fields }) as Command;

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
    yield* engine.dispatch(
      command({
        type: "thread.turn.start",
        threadId,
        text,
        attachments: [],
        mentions: [],
        queued: false,
      }),
    );
    yield* Fiber.join(done);
  });

/**
 * A thread imported as the importer makes one — the import recorded on
 * `thread.create`, the transcript as completed rows — which then runs two
 * turns. Returns what its sessions were sent and how they were opened.
 */
const importAndRun = (options: { readonly resume: Resume; readonly canResume?: boolean }) =>
  Effect.gen(function* () {
    const canResume = options.canResume ?? true;
    const { fake, instance, resumes } = yield* openInstance(options.resume, canResume);
    const threadId = makeThreadId();
    const projectId = makeProjectId();
    const doc = yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(
        command({ type: "project.create", projectId, name: "demo", workspaceRoot: "/repo" }),
      );
      const receipt = yield* engine.dispatch(
        command({
          type: "thread.create",
          threadId,
          projectId,
          settings: { model: "fake/model", connectorInstanceId: instance.instanceId },
          imported: {
            connectorKind: instance.kind,
            sourceId: SOURCE_ID,
            ...(canResume
              ? { session: { connectorInstanceId: instance.instanceId, sessionRef: SOURCE_REF } }
              : {}),
          },
        }),
      );
      expect(receipt.status).toBe("accepted");
      const env = yield* EngineEnv;
      yield* engine.appendThreadEvents(
        threadId,
        transcriptEvents(
          threadId,
          [
            { role: "user", text: "Add a health check." },
            { role: "assistant", text: "Added GET /healthz." },
          ],
          "2026-09-20T10:00:00.000Z",
          env,
        ),
      );
      expect((yield* engine.threadDoc(threadId))!.session).toBeNull();
      yield* runTurn(engine, threadId, "and now?");
      yield* runTurn(engine, threadId, "then?");
      return (yield* engine.threadDoc(threadId))!;
    }).pipe(Effect.provide(stackLayer({ instance })));

    const sent: Array<string> = [];
    for (const session of yield* fake.sessions) {
      for (const call of yield* session.calls) {
        if (call.method === "send") sent.push(call.detail.text as string);
      }
    }
    return { doc, sent, resumes };
  });

const TRANSCRIPT = "User:\nAdd a health check.\n\nAssistant:\nAdded GET /healthz.";

describe("an imported thread's first turn", () => {
  it.effect("resumes the harness's session by its reference, and sends only what was typed", () =>
    Effect.gen(function* () {
      const { doc, sent, resumes } = yield* importAndRun({ resume: "resumes" });
      expect(resumes).toHaveLength(1);
      expect(resumes[0]).toMatchObject({ sessionRef: SOURCE_REF });
      expect(resumes[0]).not.toHaveProperty("fork");
      expect(doc.session?.sessionRef).toEqual(SOURCE_REF);
      expect(sent).toEqual(["and now?", "then?"]);
    }),
  );

  it.effect("starts fresh with the transcript when the resume fails", () =>
    Effect.gen(function* () {
      const { doc, sent, resumes } = yield* importAndRun({ resume: "refuses" });
      expect(resumes).toHaveLength(1);
      expect(doc.session?.sessionRef).not.toEqual(SOURCE_REF);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain(TRANSCRIPT);
      // The first turn's own message is not in the transcript.
      expect(sent[0]!.split("and now?")).toHaveLength(2);
      expect(sent[0]!.endsWith("The user's new message:\n\nand now?")).toBe(true);
      expect(sent[1]).toBe("then?");
    }),
  );

  it.effect("sends the transcript when the connector started afresh in the resume's place", () =>
    Effect.gen(function* () {
      const { sent, resumes } = yield* importAndRun({ resume: "starts-afresh" });
      expect(resumes).toHaveLength(1);
      expect(sent[0]).toContain(TRANSCRIPT);
      expect(sent[1]).toBe("then?");
    }),
  );

  it.effect("sends the transcript on an instance that cannot resume", () =>
    Effect.gen(function* () {
      const { sent, resumes } = yield* importAndRun({ resume: "resumes", canResume: false });
      expect(resumes).toEqual([]);
      expect(sent[0]).toContain(TRANSCRIPT);
      expect(sent[1]).toBe("then?");
    }),
  );
});
