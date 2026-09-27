import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  Attachment,
  Command,
  CommandType,
  OrchestrationEvent,
  OrchestrationEventType,
  ThreadStreamItem,
  ThreadSummary,
  TurnReference,
  commandTypes,
  latestTurnId,
  orchestrationEventTypes,
  threadLocksConnector,
} from "./orchestration";
import { makeTurnId } from "./ids";

describe("Command", () => {
  it.effect("declares one union member per CommandType, in the same order", () =>
    Effect.gen(function* () {
      const fromUnion = yield* Effect.succeed(commandTypes);
      expect(fromUnion).toEqual(CommandType.literals);
    }),
  );

  it.effect("rejects a command that is missing its commandId", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(Command)({
          type: "thread.archive",
          createdAt: "2026-09-15T12:00:00.000Z",
          threadId: "0199b0f0-0000-7000-8000-000000000001",
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("OrchestrationEvent", () => {
  it.effect("declares one union member per OrchestrationEventType, in the same order", () =>
    Effect.gen(function* () {
      const fromUnion = yield* Effect.succeed(orchestrationEventTypes);
      expect(fromUnion).toEqual(OrchestrationEventType.literals);
    }),
  );

  it.effect("has no duplicate type tags", () =>
    Effect.gen(function* () {
      const tags = yield* Effect.succeed(orchestrationEventTypes);
      expect(new Set(tags).size).toBe(tags.length);
    }),
  );
});

describe("ThreadStreamItem", () => {
  const decode = Schema.decodeUnknownSync(ThreadStreamItem);

  it.effect("carries the four frames a subscriber can receive", () =>
    Effect.gen(function* () {
      const synchronized = yield* Effect.sync(() => decode({ kind: "synchronized" }));
      const resnapshot = yield* Effect.sync(() =>
        decode({ kind: "resnapshot-required", reason: "budget exceeded" }),
      );
      expect(synchronized.kind).toBe("synchronized");
      expect(resnapshot.kind).toBe("resnapshot-required");
    }),
  );

  it.effect("refuses a frame kind nothing knows how to render", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(ThreadStreamItem)({ kind: "partial" }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("Attachment", () => {
  const decode = Schema.decodeUnknownSync(Attachment);

  it.effect("carries a reference to a staged file, never its bytes", () =>
    Effect.gen(function* () {
      const reference = {
        path: "/Users/dev/.poseidon/attachments/thread/3f8a1c0d9e2b-design.png",
        mime: "image/png",
        name: "design.png",
        size: 20481,
        sha256: "3f8a1c0d9e2b4a76c5d8e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0",
      };
      const decoded = yield* Effect.sync(() => decode(reference));
      const encoded = yield* Effect.sync(() => Schema.encodeUnknownSync(Attachment)(decoded));
      expect(encoded).toStrictEqual(reference);
      expect(Object.keys(reference)).not.toContain("base64");
    }),
  );

  it.effect("still accepts the bare path an earlier client would send", () =>
    Effect.gen(function* () {
      const decoded = yield* Effect.sync(() => decode({ path: "attachments/design.png" }));
      expect(decoded.name).toBeUndefined();
      expect(decoded.sha256).toBeUndefined();
    }),
  );

  it.effect("refuses a negative size", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(Attachment)({ path: "a.png", size: -1 }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("ThreadSettings.connectorInstanceId", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationEvent);
  const INSTANCE = "0199c0de-0003-7000-8000-000000000001";

  const threadCreated = (settings: Record<string, unknown>) => ({
    sequence: 3,
    eventId: "0199c0de-0006-7000-8000-000000000103",
    streamKind: "thread",
    streamId: "0199c0de-0002-7000-8000-000000000001",
    streamVersion: 1,
    occurredAt: "2026-09-15T12:00:03.000Z",
    actor: "user",
    type: "thread.created",
    payload: {
      threadId: "0199c0de-0002-7000-8000-000000000001",
      projectId: "0199c0de-0001-7000-8000-000000000001",
      title: "Health check endpoint",
      settings: {
        model: "vendor/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
        ...settings,
      },
    },
  });

  it.effect("still decodes a thread.created written before threads chose a connector", () =>
    Effect.gen(function* () {
      const event = yield* Effect.sync(() => decode(threadCreated({})));
      if (event.type !== "thread.created") throw new Error(event.type);
      expect(event.payload.settings.connectorInstanceId).toBeUndefined();
    }),
  );

  it.effect("carries the instance a thread chose", () =>
    Effect.gen(function* () {
      const event = yield* Effect.sync(() =>
        decode(threadCreated({ connectorInstanceId: INSTANCE })),
      );
      if (event.type !== "thread.created") throw new Error(event.type);
      expect(event.payload.settings.connectorInstanceId).toBe(INSTANCE);
    }),
  );

  it.effect("travels on thread.settings.update", () =>
    Effect.gen(function* () {
      const command = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(Command)({
          commandId: "0199c0de-0008-7000-8000-000000000001",
          createdAt: "2026-09-15T12:00:00.000Z",
          type: "thread.settings.update",
          threadId: "0199c0de-0002-7000-8000-000000000001",
          connectorInstanceId: INSTANCE,
        }),
      );
      if (command.type !== "thread.settings.update") throw new Error(command.type);
      expect(command.connectorInstanceId).toBe(INSTANCE);
    }),
  );
});

describe("ThreadSummary.runningSince", () => {
  const decode = Schema.decodeUnknownSync(ThreadSummary);
  const encode = Schema.encodeSync(ThreadSummary);
  const summary = {
    threadId: "0199c0de-0002-7000-8000-000000000001",
    projectId: "0199c0de-0001-7000-8000-000000000001",
    title: "Health check endpoint",
    status: "running",
    settings: {
      model: "vendor/model",
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
    awaitingInput: false,
    activity: "thinking",
    createdAt: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:04:00.000Z",
  };

  it.effect("still decodes a summary written before the field existed", () =>
    Effect.gen(function* () {
      const decoded = yield* Effect.sync(() => decode(summary));
      expect(decoded.runningSince).toBeUndefined();
    }),
  );

  it.effect("round-trips the turn's start", () =>
    Effect.gen(function* () {
      const withStart = { ...summary, runningSince: "2026-09-15T12:01:00.000Z" };
      const decoded = yield* Effect.sync(() => decode(withStart));
      expect(decoded.runningSince).toBe("2026-09-15T12:01:00.000Z");
      expect(encode(decoded)).toEqual(withStart);
    }),
  );
});

describe("TurnReference", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationEvent);
  const REFERENCES = [
    { kind: "skill", name: "health-checks" },
    { kind: "plugin", name: "smoke-tests" },
  ];

  const event = (type: string, sequence: number, payload: Record<string, unknown>) => ({
    sequence,
    eventId: `0199c0de-0006-7000-8000-00000000020${sequence}`,
    streamKind: "thread",
    streamId: "0199c0de-0002-7000-8000-000000000001",
    streamVersion: sequence,
    occurredAt: "2026-09-15T12:00:03.000Z",
    actor: "system",
    type,
    payload,
  });

  const turnRequested = (extra: Record<string, unknown>) =>
    event("thread.turn.requested", 1, {
      turnId: "0199c0de-0004-7000-8000-000000000001",
      text: "Add a health check",
      attachments: [],
      mentions: [],
      ...extra,
    });

  const messageQueued = (extra: Record<string, unknown>) =>
    event("thread.message.queued", 2, {
      message: {
        queuedMessageId: "0199c0de-0010-7000-8000-000000000001",
        text: "Then the readiness probe",
        attachments: [],
        mentions: [],
        queuedAt: "2026-09-15T12:00:00.000Z",
        ...extra,
      },
    });

  const userMessage = (extra: Record<string, unknown>) =>
    event("thread.item.upserted", 3, {
      item: {
        itemId: "0199c0de-0005-7000-8000-000000000001",
        kind: "user_message",
        status: "completed",
        text: "Add a health check",
        ...extra,
      },
      turnId: "0199c0de-0004-7000-8000-000000000001",
    });

  it.effect("still decodes a turn, a queued message and a user row written before references", () =>
    Effect.gen(function* () {
      const requested = yield* Effect.sync(() => decode(turnRequested({})));
      const queued = yield* Effect.sync(() => decode(messageQueued({})));
      const upserted = yield* Effect.sync(() => decode(userMessage({})));
      if (requested.type !== "thread.turn.requested") throw new Error(requested.type);
      if (queued.type !== "thread.message.queued") throw new Error(queued.type);
      if (upserted.type !== "thread.item.upserted") throw new Error(upserted.type);
      expect(requested.payload.references).toBeUndefined();
      expect(queued.payload.message.references).toBeUndefined();
      expect(upserted.payload.item.references).toBeUndefined();
    }),
  );

  it.effect("carries skill and plugin references through every event that holds a turn", () =>
    Effect.gen(function* () {
      for (const raw of [
        turnRequested({ references: REFERENCES }),
        messageQueued({ references: REFERENCES }),
        userMessage({ references: REFERENCES }),
      ]) {
        const decoded = yield* Effect.sync(() => decode(raw));
        const encoded = yield* Effect.sync(() =>
          Schema.encodeUnknownSync(OrchestrationEvent)(decoded),
        );
        expect(encoded).toStrictEqual(raw);
      }
    }),
  );

  it.effect("travels on thread.turn.start, and may be left out", () =>
    Effect.gen(function* () {
      const start = (extra: Record<string, unknown>) =>
        Schema.decodeUnknownSync(Command)({
          commandId: "0199c0de-0008-7000-8000-000000000001",
          createdAt: "2026-09-15T12:00:00.000Z",
          type: "thread.turn.start",
          threadId: "0199c0de-0002-7000-8000-000000000001",
          text: "Add a health check",
          attachments: [],
          mentions: [],
          queued: false,
          ...extra,
        });
      const without = yield* Effect.sync(() => start({}));
      const withReferences = yield* Effect.sync(() => start({ references: REFERENCES }));
      if (without.type !== "thread.turn.start") throw new Error(without.type);
      if (withReferences.type !== "thread.turn.start") throw new Error(withReferences.type);
      expect(without.references).toBeUndefined();
      expect(withReferences.references).toEqual(REFERENCES);
    }),
  );

  it.effect("refuses a kind other than skill or plugin, and an empty name", () =>
    Effect.gen(function* () {
      const wrongKind = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(TurnReference)({ kind: "file", name: "a" }),
      );
      const emptyName = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(TurnReference)({ kind: "skill", name: "" }),
      );
      expect(wrongKind._tag).toBe("Failure");
      expect(emptyName._tag).toBe("Failure");
    }),
  );
});

describe("threadLocksConnector", () => {
  const fresh = { session: null, items: [], currentTurnId: null };

  it("leaves a thread nothing has run on free to choose", () => {
    expect(threadLocksConnector(fresh)).toBe(false);
    expect(threadLocksConnector({ ...fresh, items: [{ kind: "error" }] })).toBe(false);
  });

  it("locks once the user sent a message, a session is bound or a turn runs", () => {
    expect(threadLocksConnector({ ...fresh, items: [{ kind: "user_message" }] })).toBe(true);
    expect(threadLocksConnector({ ...fresh, session: { sessionRef: {} } })).toBe(true);
    expect(threadLocksConnector({ ...fresh, currentTurnId: "turn" })).toBe(true);
    // The server's own document names the running turn `currentTurn`.
    expect(threadLocksConnector({ session: null, items: [], currentTurn: {} })).toBe(true);
  });
});

describe("latestTurnId", () => {
  const [t1, t2] = [makeTurnId(), makeTurnId()];

  it("names the last turn to first appear in the items", () => {
    expect(latestTurnId([{ turnId: t1 }, {}, { turnId: t2 }, { turnId: t2 }])).toBe(t2);
    // A late row of an earlier turn does not make that turn the latest again.
    expect(latestTurnId([{ turnId: t1 }, { turnId: t2 }, { turnId: t1 }])).toBe(t2);
  });

  it("is null before any turn", () => {
    expect(latestTurnId([])).toBeNull();
    expect(latestTurnId([{}, { turnId: undefined }])).toBeNull();
  });
});
