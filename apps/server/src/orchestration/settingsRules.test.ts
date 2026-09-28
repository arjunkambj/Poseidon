/**
 * A thread's ultracode flag, from command to stored settings: the decider's
 * rules (on means `xhigh`, off keeps the effort, an effort pick switches it
 * off) and the fold that stores what the events say.
 */

import { describe, expect, it } from "vitest";

import {
  makeCommandId,
  makeEventId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@poseidon/contracts/ids";
import type {
  Command,
  OrchestrationEvent,
  ThreadSettings,
} from "@poseidon/contracts/orchestration";

import { decide, type DeciderContext, type DecideEnv } from "./decider";
import type { PlannedEvent } from "../persistence/EventStore";
import { foldThread, type ThreadDoc } from "./state";

const NOW = "2026-01-02T03:04:05.000Z";

const env: DecideEnv = {
  now: NOW,
  nextEventId: makeEventId,
  nextTurnId: makeTurnId,
  nextItemId: makeItemId,
};

const ctx = (overrides: Partial<DeciderContext> = {}): DeciderContext => ({
  projectExists: () => true,
  workspaceRootTaken: () => false,
  restoreInFlight: () => false,
  defaultModel: "claude/opus",
  defaultEffort: null,
  defaultRuntimeMode: null,
  ...overrides,
});

const threadId = makeThreadId();
const projectId = makeProjectId();

/** Planned events numbered as the store would number them. */
const stored = (planned: ReadonlyArray<PlannedEvent>, from = 0): Array<OrchestrationEvent> =>
  planned.map(
    (each, index) =>
      ({
        ...each,
        sequence: from + index + 1,
        streamVersion: from + index + 1,
      }) as OrchestrationEvent,
  );

const eventsOf = (result: ReturnType<typeof decide>): ReadonlyArray<PlannedEvent> => {
  if (!result.accepted) {
    throw new Error(result.reason);
  }
  return result.events;
};

const create = (settings: Record<string, unknown>, context = ctx()) =>
  eventsOf(
    decide(
      {
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "thread.create",
        threadId,
        projectId,
        settings,
      } as unknown as Command,
      { project: null, thread: null },
      context,
      env,
    ),
  );

/** A thread folded from its creation with `settings`, and its event log. */
const threadWith = (settings: Record<string, unknown>) => {
  const log = stored(create(settings));
  return { log, doc: foldThread(log)! };
};

const update = (doc: ThreadDoc, fields: Record<string, unknown>) =>
  eventsOf(
    decide(
      {
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "thread.settings.update",
        threadId: doc.threadId,
        ...fields,
      } as unknown as Command,
      { project: null, thread: doc },
      ctx(),
      env,
    ),
  );

/** The stored settings after the update is decided and folded. */
const settingsAfter = (
  thread: { log: Array<OrchestrationEvent>; doc: ThreadDoc },
  fields: Record<string, unknown>,
): ThreadSettings =>
  foldThread([...thread.log, ...stored(update(thread.doc, fields), thread.log.length)])!.settings;

describe("a new thread's ultracode", () => {
  it("starts at xhigh when the patch switches ultracode on, over the patch's own effort", () => {
    const [created] = create({ effort: "low", ultracode: true });
    expect(created?.payload).toMatchObject({ settings: { effort: "xhigh", ultracode: true } });
  });

  it("starts at xhigh over the Settings default effort too", () => {
    const [created] = create({ ultracode: true }, ctx({ defaultEffort: "max" }));
    expect(created?.payload).toMatchObject({ settings: { effort: "xhigh", ultracode: true } });
  });

  it("records nothing for an ultracode that is off", () => {
    const [created] = create({ effort: "high", ultracode: false });
    const settings = (created!.payload as { settings: ThreadSettings }).settings;
    expect(settings.effort).toBe("high");
    expect(settings).not.toHaveProperty("ultracode");
  });

  it("is stored by the fold", () => {
    expect(threadWith({ ultracode: true }).doc.settings).toMatchObject({
      effort: "xhigh",
      ultracode: true,
    });
  });
});

describe("updating a thread's ultracode", () => {
  it("switching it on sets the effort to xhigh", () => {
    const thread = threadWith({ effort: "low" });
    expect(update(thread.doc, { ultracode: true })[0]?.payload).toEqual({
      effort: "xhigh",
      ultracode: true,
    });
    expect(settingsAfter(thread, { ultracode: true })).toMatchObject({
      effort: "xhigh",
      ultracode: true,
    });
  });

  it("switching it off keeps the effort", () => {
    const thread = threadWith({ ultracode: true });
    expect(update(thread.doc, { ultracode: false })[0]?.payload).toEqual({ ultracode: false });
    expect(settingsAfter(thread, { ultracode: false })).toMatchObject({
      effort: "xhigh",
      ultracode: false,
    });
  });

  it("picking an effort switches it off", () => {
    const thread = threadWith({ ultracode: true });
    expect(update(thread.doc, { effort: "high" })[0]?.payload).toEqual({
      effort: "high",
      ultracode: false,
    });
    // Picking xhigh itself still leaves ultracode, as the harness does.
    expect(settingsAfter(thread, { effort: "xhigh" })).toMatchObject({
      effort: "xhigh",
      ultracode: false,
    });
  });

  it("leaves ultracode out of an effort pick on a thread that never had it", () => {
    const thread = threadWith({});
    expect(update(thread.doc, { effort: "high" })[0]?.payload).toEqual({ effort: "high" });
    expect(settingsAfter(thread, { effort: "high" })).not.toHaveProperty("ultracode");
  });

  it("keeps ultracode through a patch that names neither", () => {
    const thread = threadWith({ ultracode: true });
    expect(update(thread.doc, { runtimeMode: "full-access" })[0]?.payload).toEqual({
      runtimeMode: "full-access",
    });
    expect(settingsAfter(thread, { runtimeMode: "full-access" })).toMatchObject({
      effort: "xhigh",
      ultracode: true,
    });
  });
});

describe("the stored ultracode flag", () => {
  it("loads a thread stored before the flag existed unchanged", () => {
    const [created] = stored([
      {
        eventId: makeEventId(),
        streamKind: "thread",
        streamId: threadId,
        occurredAt: NOW,
        actor: "user",
        type: "thread.created",
        payload: {
          threadId,
          projectId,
          title: "Old",
          settings: {
            model: "claude/opus",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        },
      } as PlannedEvent,
    ]);
    const updated = {
      ...created!,
      sequence: 2,
      streamVersion: 2,
      eventId: makeEventId(),
      type: "thread.settings.updated",
      payload: { effort: "high" },
    } as OrchestrationEvent;
    expect(foldThread([created!, updated])!.settings).toEqual({
      model: "claude/opus",
      effort: "high",
      runtimeMode: "full-access",
      interactionMode: "default",
    });
  });

  it("takes what a connector's model.changed reports", () => {
    const thread = threadWith({ ultracode: true });
    const reported = {
      ...thread.log[0]!,
      sequence: 2,
      streamVersion: 2,
      eventId: makeEventId(),
      actor: "connector",
      type: "thread.settings.updated",
      payload: { model: "claude/sonnet", ultracode: false },
    } as OrchestrationEvent;
    expect(foldThread([...thread.log, reported])!.settings).toMatchObject({
      model: "claude/sonnet",
      effort: "xhigh",
      ultracode: false,
    });
  });
});

describe("forking a thread with ultracode", () => {
  const { doc: source } = threadWith({ ultracode: true });
  const fork = (settings?: Record<string, unknown>) =>
    eventsOf(
      decide(
        {
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.create",
          threadId: makeThreadId(),
          projectId,
          fork: { threadId: source.threadId },
          ...(settings === undefined ? {} : { settings }),
        } as unknown as Command,
        { project: null, thread: null },
        ctx({ forkSource: source }),
        env,
      ),
    )[0]?.payload as { settings: ThreadSettings };

  it("copies it with the source's effort", () => {
    expect(fork().settings).toMatchObject({ effort: "xhigh", ultracode: true });
  });

  it("leaves it behind when the fork picks its own effort", () => {
    const settings = fork({ effort: "low" }).settings;
    expect(settings.effort).toBe("low");
    expect(settings).not.toHaveProperty("ultracode");
  });

  it("lets the fork switch it off and keep the effort", () => {
    const settings = fork({ ultracode: false }).settings;
    expect(settings.effort).toBe("xhigh");
    expect(settings).not.toHaveProperty("ultracode");
  });
});
