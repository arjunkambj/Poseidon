import { describe, expect, it } from "vitest";

import {
  makeCommandId,
  makeConnectorInstanceId,
  makeEventId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";
import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

import { decide, type DeciderContext, type DecideEnv } from "./decider";
import type { ProjectDoc, ThreadDoc } from "./state";

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
  defaultModel: "fake/model",
  defaultEffort: null,
  defaultRuntimeMode: null,
  ...overrides,
});

const baseCommand = { commandId: makeCommandId(), createdAt: NOW };

const QUEUED_ID = makeItemId();
const SECOND_QUEUED_ID = makeItemId();

const queuedMessage = (queuedMessageId: string, text: string) => ({
  queuedMessageId: queuedMessageId as ReturnType<typeof makeItemId>,
  text,
  attachments: [],
  mentions: [],
  queuedAt: NOW,
});

const threadDoc = (overrides: Partial<ThreadDoc> = {}): ThreadDoc => ({
  threadId: makeThreadId(),
  projectId: makeProjectId(),
  title: "Thread",
  status: "idle",
  settings: {
    model: "fake/model",
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  worktree: null,
  snapshotSequence: 1,
  items: [],
  queue: [],
  checkpoints: [],
  session: null,
  currentTurn: null,
  interrupting: false,
  restoring: false,
  restoringCheckpoint: null,
  restores: [],
  pendingPlan: null,
  decisions: [],
  usage: null,
  context: null,
  createdAt: NOW,
  updatedAt: NOW,
  doneAt: null,
  approvals: [],
  userInputs: [],
  preview: undefined,
  deleted: false,
  ...overrides,
});

const projectDoc = (overrides: Partial<ProjectDoc> = {}): ProjectDoc => ({
  projectId: makeProjectId(),
  name: "demo",
  workspaceRoot: "/repo",
  createdAt: NOW,
  updatedAt: NOW,
  removed: false,
  ...overrides,
});

interface Row {
  readonly name: string;
  readonly command: Command;
  readonly thread?: ThreadDoc | null;
  readonly project?: ProjectDoc | null;
  readonly context?: DeciderContext;
  readonly events?: ReadonlyArray<string>;
  readonly rejects?: string;
  readonly rule?: { readonly scope: string; readonly pattern: string };
}

const rows: ReadonlyArray<Row> = [
  {
    name: "project.create emits project.created",
    command: {
      ...baseCommand,
      type: "project.create",
      projectId: makeProjectId(),
      name: "demo",
      workspaceRoot: "/repo",
    } as Command,
    project: null,
    events: ["project.created"],
  },
  {
    name: "project.create rejects an existing project",
    command: {
      ...baseCommand,
      type: "project.create",
      projectId: makeProjectId(),
      name: "demo",
      workspaceRoot: "/repo",
    } as Command,
    project: projectDoc(),
    rejects: "already exists",
  },
  {
    name: "project.create rejects a taken workspace root",
    command: {
      ...baseCommand,
      type: "project.create",
      projectId: makeProjectId(),
      name: "demo",
      workspaceRoot: "/repo",
    } as Command,
    project: null,
    context: ctx({ workspaceRootTaken: () => true }),
    rejects: "already a project",
  },
  {
    name: "project.remove emits project.removed",
    command: {
      ...baseCommand,
      type: "project.remove",
      projectId: makeProjectId(),
    } as Command,
    project: projectDoc(),
    events: ["project.removed"],
  },
  {
    name: "project.remove rejects a missing project",
    command: {
      ...baseCommand,
      type: "project.remove",
      projectId: makeProjectId(),
    } as Command,
    project: null,
    rejects: "does not exist",
  },
  {
    name: "thread.create emits thread.created with resolved settings",
    command: {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as Command,
    thread: null,
    events: ["thread.created"],
  },
  {
    name: "thread.create rejects a missing project",
    command: {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as Command,
    thread: null,
    context: ctx({ projectExists: () => false }),
    rejects: "does not exist",
  },
  {
    name: "thread.create rejects when no model resolves, pointing at the Models page",
    command: {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as Command,
    thread: null,
    context: ctx({ defaultModel: null }),
    rejects: "no model is configured — pick a default in Settings → Models",
  },
  {
    name: "thread.rename emits thread.renamed",
    command: {
      ...baseCommand,
      type: "thread.rename",
      threadId: makeThreadId(),
      title: "New title",
    } as Command,
    thread: threadDoc(),
    events: ["thread.renamed"],
  },
  {
    name: "thread.rename rejects a missing thread",
    command: {
      ...baseCommand,
      type: "thread.rename",
      threadId: makeThreadId(),
      title: "New title",
    } as Command,
    thread: null,
    rejects: "does not exist",
  },
  {
    name: "thread.archive emits thread.archived",
    command: {
      ...baseCommand,
      type: "thread.archive",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    events: ["thread.archived"],
  },
  {
    name: "thread.archive rejects an archived thread",
    command: {
      ...baseCommand,
      type: "thread.archive",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({ status: "archived" }),
    rejects: "already archived",
  },
  {
    name: "thread.unarchive emits thread.unarchived",
    command: {
      ...baseCommand,
      type: "thread.unarchive",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({ status: "archived" }),
    events: ["thread.unarchived"],
  },
  {
    name: "thread.unarchive rejects a thread that is not archived",
    command: {
      ...baseCommand,
      type: "thread.unarchive",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    rejects: "not archived",
  },
  {
    name: "thread.unarchive rejects a missing thread",
    command: {
      ...baseCommand,
      type: "thread.unarchive",
      threadId: makeThreadId(),
    } as Command,
    thread: null,
    rejects: "does not exist",
  },
  {
    name: "thread.done.mark emits thread.done.marked",
    command: {
      ...baseCommand,
      type: "thread.done.mark",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    events: ["thread.done.marked"],
  },
  {
    name: "thread.done.mark marks a thread that is already done again",
    command: {
      ...baseCommand,
      type: "thread.done.mark",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({ doneAt: NOW }),
    events: ["thread.done.marked"],
  },
  {
    name: "thread.done.mark rejects a missing thread",
    command: {
      ...baseCommand,
      type: "thread.done.mark",
      threadId: makeThreadId(),
    } as Command,
    thread: null,
    rejects: "does not exist",
  },
  {
    name: "thread.done.mark rejects a deleted thread",
    command: {
      ...baseCommand,
      type: "thread.done.mark",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({ deleted: true }),
    rejects: "does not exist",
  },
  {
    name: "thread.done.mark rejects an archived thread",
    command: {
      ...baseCommand,
      type: "thread.done.mark",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({ status: "archived" }),
    rejects: "is archived",
  },
  {
    name: "thread.done.clear emits thread.done.cleared",
    command: {
      ...baseCommand,
      type: "thread.done.clear",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({ doneAt: NOW }),
    events: ["thread.done.cleared"],
  },
  {
    name: "thread.done.clear accepts a thread never marked, which may have gone to Done on its own",
    command: {
      ...baseCommand,
      type: "thread.done.clear",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    events: ["thread.done.cleared"],
  },
  {
    name: "thread.done.clear rejects a missing thread",
    command: {
      ...baseCommand,
      type: "thread.done.clear",
      threadId: makeThreadId(),
    } as Command,
    thread: null,
    rejects: "does not exist",
  },
  {
    name: "thread.done.clear rejects a deleted thread",
    command: {
      ...baseCommand,
      type: "thread.done.clear",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({ deleted: true }),
    rejects: "does not exist",
  },
  {
    name: "thread.delete emits thread.deleted",
    command: {
      ...baseCommand,
      type: "thread.delete",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    events: ["thread.deleted"],
  },
  {
    name: "thread.turn.start emits thread.turn.requested",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc(),
    // The user's own timeline row is minted with the turn: nothing else does.
    events: ["thread.turn.requested", "thread.item.upserted"],
  },
  {
    name: "thread.turn.start rejects during a turn when not queued",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
    }),
    rejects: "already running",
  },
  {
    name: "thread.turn.start queues during a turn",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "queued work",
      attachments: [],
      mentions: [],
      queued: true,
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
    }),
    events: ["thread.message.queued"],
  },
  {
    name: "thread.turn.start queues rather than rejecting while an interrupt settles",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "typed right after stop",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      interrupting: true,
      status: "running",
    }),
    events: ["thread.message.queued"],
  },
  {
    name: "thread.turn.start rejects on an archived thread",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc({ status: "archived" }),
    rejects: "archived",
  },
  {
    name: "thread.turn.interrupt emits thread.turn.interrupted",
    command: {
      ...baseCommand,
      type: "thread.turn.interrupt",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
    }),
    events: ["thread.turn.interrupted"],
  },
  {
    name: "thread.turn.interrupt rejects with no running turn",
    command: {
      ...baseCommand,
      type: "thread.turn.interrupt",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    rejects: "no running turn",
  },
  {
    name: "thread.turn.interrupt rejects a second stop while the first settles",
    command: {
      ...baseCommand,
      type: "thread.turn.interrupt",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      interrupting: true,
      status: "running",
    }),
    rejects: "already stopping",
  },
  {
    name: "thread.settings.update emits thread.settings.updated",
    command: {
      ...baseCommand,
      type: "thread.settings.update",
      threadId: makeThreadId(),
      runtimeMode: "auto-accept-edits",
    } as Command,
    thread: threadDoc(),
    events: ["thread.settings.updated"],
  },
  {
    name: "thread.approval.respond resolves a pending request",
    command: {
      ...baseCommand,
      type: "thread.approval.respond",
      threadId: makeThreadId(),
      requestId: "req-1" as Command extends infer _ ? never : never,
      decision: "allow-once",
    } as unknown as Command,
    thread: threadDoc({
      approvals: [
        {
          requestId: "req-1" as never,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls" },
          description: "Run ls",
        },
      ],
      status: "waiting",
    }),
    events: ["thread.approval.resolved"],
  },
  {
    name: "thread.approval.respond rejects an unknown request",
    command: {
      ...baseCommand,
      type: "thread.approval.respond",
      threadId: makeThreadId(),
      requestId: "req-unknown",
      decision: "allow-once",
    } as unknown as Command,
    thread: threadDoc(),
    rejects: "no pending approval",
  },
  {
    name: "thread.approval.respond allow-always records a project rule",
    command: {
      ...baseCommand,
      type: "thread.approval.respond",
      threadId: makeThreadId(),
      requestId: "req-1",
      decision: "allow-always",
      pattern: "Shell(npm run *)",
    } as unknown as Command,
    thread: threadDoc({
      approvals: [
        {
          requestId: "req-1" as never,
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm run build" },
          description: "Run build",
        },
      ],
      status: "waiting",
    }),
    events: ["thread.approval.resolved"],
    rule: { scope: "project", pattern: "Shell(npm run *)" },
  },
  {
    name: "thread.approval.respond allow-session records a session rule",
    command: {
      ...baseCommand,
      type: "thread.approval.respond",
      threadId: makeThreadId(),
      requestId: "req-1",
      decision: "allow-session",
      pattern: "Shell(ls *)",
    } as unknown as Command,
    thread: threadDoc({
      approvals: [
        {
          requestId: "req-1" as never,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls -la" },
          description: "List files",
        },
      ],
      status: "waiting",
    }),
    events: ["thread.approval.resolved"],
    rule: { scope: "session", pattern: "Shell(ls *)" },
  },
  {
    name: "thread.userInput.respond resolves a pending request",
    command: {
      ...baseCommand,
      type: "thread.userInput.respond",
      threadId: makeThreadId(),
      requestId: "req-in",
      answers: [],
    } as unknown as Command,
    thread: threadDoc({
      userInputs: [{ requestId: "req-in" as never, questions: [] }],
      status: "waiting",
    }),
    events: ["thread.userInput.resolved"],
  },
  {
    name: "thread.userInput.respond rejects an unknown request",
    command: {
      ...baseCommand,
      type: "thread.userInput.respond",
      threadId: makeThreadId(),
      requestId: "req-none",
      answers: [],
    } as unknown as Command,
    thread: threadDoc(),
    rejects: "no pending user input",
  },
  {
    name: "thread.plan.respond accepts a pending plan",
    command: {
      ...baseCommand,
      type: "thread.plan.respond",
      threadId: makeThreadId(),
      turnId: "turn-1",
      action: "accept",
    } as unknown as Command,
    thread: threadDoc({
      pendingPlan: {
        turnId: "turn-1" as never,
        planMarkdown: "# Plan",
      },
      status: "waiting",
    }),
    events: ["thread.plan.responded"],
  },
  {
    name: "thread.plan.respond accepts a handoff to a new thread",
    command: {
      ...baseCommand,
      type: "thread.plan.respond",
      threadId: makeThreadId(),
      turnId: "turn-1",
      action: "handoff",
    } as unknown as Command,
    thread: threadDoc({
      pendingPlan: { turnId: "turn-1" as never, planMarkdown: "# Plan" },
      status: "waiting",
    }),
    events: ["thread.plan.responded"],
  },
  {
    name: "thread.plan.respond rejects a mismatched turn",
    command: {
      ...baseCommand,
      type: "thread.plan.respond",
      threadId: makeThreadId(),
      turnId: "turn-2",
      action: "accept",
    } as unknown as Command,
    thread: threadDoc({
      pendingPlan: { turnId: "turn-1" as never, planMarkdown: "# Plan" },
      status: "waiting",
    }),
    rejects: "no pending plan",
  },
  {
    name: "thread.checkpoint.restore emits the durable work order",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
    } as unknown as Command,
    thread: threadDoc({
      checkpoints: [
        {
          checkpointId: "cp-1" as never,
          turnId: makeTurnId(),
          ref: "refs/ade/checkpoint/cp-1",
          createdAt: NOW,
        },
      ],
    }),
    events: ["thread.checkpoint.restore.requested"],
  },
  {
    name: "thread.checkpoint.restore rejects while a turn is running",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
    } as unknown as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
      checkpoints: [
        {
          checkpointId: "cp-1" as never,
          turnId: makeTurnId(),
          ref: "refs/ade/checkpoint/cp-1",
          createdAt: NOW,
        },
      ],
    }),
    rejects: "running turn",
  },
  {
    name: "thread.turn.start rejects while a checkpoint restore is in flight",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc({ restoring: true }),
    rejects: "restoring a checkpoint",
  },
  {
    name: "thread.checkpoint.restore rejects a second restore while one is in flight",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
    } as unknown as Command,
    thread: threadDoc({ restoring: true }),
    rejects: "already restoring",
  },
  {
    // `git restore` + `git clean -fd` run over the project's workspace root,
    // which every thread of the project shares: a sibling's restore would
    // delete whatever this turn wrote.
    name: "thread.turn.start rejects while a sibling thread is restoring",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc(),
    context: ctx({ restoreInFlight: () => true }),
    rejects: "another thread in project",
  },
  {
    name: "thread.checkpoint.restore rejects while a sibling thread is restoring",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
    } as unknown as Command,
    thread: threadDoc({
      checkpoints: [
        {
          checkpointId: "cp-1" as never,
          turnId: makeTurnId(),
          ref: "refs/ade/checkpoint/cp-1",
          createdAt: NOW,
        },
      ],
    }),
    context: ctx({ restoreInFlight: () => true }),
    rejects: "another thread in project",
  },
  {
    name: "thread.queue.remove emits thread.message.dequeued",
    command: {
      ...baseCommand,
      type: "thread.queue.remove",
      threadId: makeThreadId(),
      queuedMessageId: QUEUED_ID,
    } as unknown as Command,
    thread: threadDoc({
      queue: [
        {
          queuedMessageId: QUEUED_ID,
          text: "take this back",
          attachments: [],
          mentions: [],
          queuedAt: NOW,
        },
      ],
    }),
    events: ["thread.message.dequeued"],
  },
  {
    name: "thread.queue.remove rejects a message the queue no longer holds",
    command: {
      ...baseCommand,
      type: "thread.queue.remove",
      threadId: makeThreadId(),
      queuedMessageId: QUEUED_ID,
    } as unknown as Command,
    thread: threadDoc(),
    rejects: "no queued message",
  },
  {
    name: "thread.queue.reorder rejects a position the queue does not have",
    command: {
      ...baseCommand,
      type: "thread.queue.reorder",
      threadId: makeThreadId(),
      queuedMessageId: QUEUED_ID,
      toIndex: 3,
    } as unknown as Command,
    thread: threadDoc({ queue: [queuedMessage(QUEUED_ID, "only one")] }),
    rejects: "no position 3",
  },
  {
    name: "thread.queue.reorder accepts a move to where the message already is",
    command: {
      ...baseCommand,
      type: "thread.queue.reorder",
      threadId: makeThreadId(),
      queuedMessageId: QUEUED_ID,
      toIndex: 0,
    } as unknown as Command,
    thread: threadDoc({ queue: [queuedMessage(QUEUED_ID, "already first")] }),
    events: [],
  },
  {
    name: "thread.checkpoint.restore rejects an unknown checkpoint",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-none",
    } as unknown as Command,
    thread: threadDoc(),
    rejects: "no checkpoint",
  },
];

describe("decide", () => {
  for (const row of rows) {
    it(row.name, () => {
      const result = decide(
        row.command,
        { project: row.project ?? null, thread: row.thread ?? null },
        row.context ?? ctx(),
        env,
      );
      if (row.rejects !== undefined) {
        expect(result.accepted).toBe(false);
        if (!result.accepted) {
          expect(result.reason).toContain(row.rejects);
        }
        return;
      }
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.events.map((event) => event.type)).toEqual(row.events);
        if (row.rule !== undefined) {
          expect(result.permissionRule?.scope).toBe(row.rule.scope);
          expect(result.permissionRule?.pattern).toBe(row.rule.pattern);
        }
      }
    });
  }

  it("copies the pending plan's path onto thread.plan.responded", () => {
    const command = {
      ...baseCommand,
      type: "thread.plan.respond",
      threadId: makeThreadId(),
      turnId: "turn-1",
      action: "accept",
    } as unknown as Command;
    const thread = threadDoc({
      pendingPlan: {
        turnId: "turn-1" as never,
        planMarkdown: "# Plan",
        planPath: "/home/u/.commandcode/plans/the-plan.md",
      },
      status: "waiting",
    });
    const result = decide(command, { project: null, thread }, ctx(), env);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      // The fold clears pendingPlan on this event, so the path has to ride
      // along on it — a reactor that restarts before the answer has no
      // other source for the file the implement turn names.
      const payload = result.events[0]!.payload as { planPath?: string };
      expect(payload.planPath).toBe("/home/u/.commandcode/plans/the-plan.md");
    }
  });

  it("emits the whole queue order when a message moves", () => {
    const command = {
      ...baseCommand,
      type: "thread.queue.reorder",
      threadId: makeThreadId(),
      queuedMessageId: SECOND_QUEUED_ID,
      toIndex: 0,
    } as unknown as Command;
    const thread = threadDoc({
      queue: [queuedMessage(QUEUED_ID, "first"), queuedMessage(SECOND_QUEUED_ID, "second")],
    });
    const result = decide(command, { project: null, thread }, ctx(), env);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.events.map((event) => event.type)).toEqual(["thread.queue.reordered"]);
      const payload = result.events[0]!.payload as { order: ReadonlyArray<string> };
      expect(payload.order).toEqual([SECOND_QUEUED_ID, QUEUED_ID]);
    }
  });

  it("emits thread.created with caller settings over defaults", () => {
    const command = {
      commandId: "cmd",
      createdAt: NOW,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      title: "Titled",
      settings: {
        model: "other/model",
        runtimeMode: "full-access",
        interactionMode: "plan",
        effort: "high",
      },
    } as unknown as Command;
    const result = decide(command, { project: null, thread: null }, ctx(), env);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      const payload = result.events[0]!.payload as { settings: unknown };
      expect(payload.settings).toEqual({
        model: "other/model",
        runtimeMode: "full-access",
        interactionMode: "plan",
        effort: "high",
      });
    }
  });

  it("takes effort and runtime mode from the settings defaults", () => {
    // The renderer's only create path sends no settings at all, so "New thread
    // defaults" is the only place these two can come from. They used to be
    // dropped: the panel wrote them, read them back and nothing applied them.
    const command = {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as unknown as Command;
    const result = decide(
      command,
      { project: null, thread: null },
      ctx({ defaultEffort: "high", defaultRuntimeMode: "full-access" }),
      env,
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      const payload = result.events[0]!.payload as { settings: unknown };
      expect(payload.settings).toEqual({
        model: "fake/model",
        runtimeMode: "full-access",
        interactionMode: "default",
        effort: "high",
      });
    }
  });

  it("keeps the built-in fallbacks when the defaults hold nothing", () => {
    const command = {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as unknown as Command;
    const result = decide(command, { project: null, thread: null }, ctx(), env);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      const payload = result.events[0]!.payload as { settings: unknown };
      expect(payload.settings).toEqual({
        model: "fake/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
    }
  });
});

describe("the user's own timeline row", () => {
  const start = (attachments: ReadonlyArray<{ path: string; mime?: string }>) =>
    decide(
      {
        ...baseCommand,
        type: "thread.turn.start",
        threadId: makeThreadId(),
        text: "what is in this picture?",
        attachments,
        mentions: [],
        queued: false,
      } as Command,
      { project: null, thread: threadDoc() },
      ctx(),
      env,
    );

  it("carries the text and the turn it belongs to", () => {
    const result = start([]);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const requested = result.events[0]!.payload as { turnId: string };
    const upserted = result.events[1]!.payload as {
      turnId: string;
      item: { kind: string; text: string; attachments?: unknown };
    };
    expect(upserted.item.kind).toBe("user_message");
    expect(upserted.item.text).toBe("what is in this picture?");
    expect(upserted.turnId).toBe(requested.turnId);
    // No attachments, no field — the row stays as small as the message.
    expect(upserted.item.attachments).toBeUndefined();
  });

  it("carries the attachment references so the row can draw a thumbnail", () => {
    const attachments = [{ path: "/home/.poseidon/attachments/t/abc-shot.png", mime: "image/png" }];
    const result = start(attachments);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const upserted = result.events[1]!.payload as { item: { attachments?: unknown } };
    expect(upserted.item.attachments).toEqual(attachments);
  });
});

describe("skill and plugin references", () => {
  const references = [
    { kind: "skill" as const, name: "release-notes" },
    { kind: "plugin" as const, name: "linters" },
  ];
  const running = threadDoc({
    currentTurn: {
      turnId: makeTurnId(),
      input: { text: "in-flight", attachments: [], mentions: [] },
    },
    status: "running",
  });
  const start = (thread: ThreadDoc, extra: Record<string, unknown>) =>
    decide(
      {
        ...baseCommand,
        type: "thread.turn.start",
        threadId: makeThreadId(),
        text: "write the notes",
        attachments: [],
        mentions: [],
        queued: true,
        ...extra,
      } as Command,
      { project: null, thread },
      ctx(),
      env,
    );

  it("ride on the turn request and on the user's row", () => {
    const result = start(threadDoc(), { references });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const requested = result.events[0]!.payload as { references?: unknown };
    const upserted = result.events[1]!.payload as { item: { references?: unknown } };
    expect(requested.references).toEqual(references);
    expect(upserted.item.references).toEqual(references);
  });

  it("stay with a message queued behind a running turn", () => {
    const result = start(running, { references });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events.map((event) => event.type)).toEqual(["thread.message.queued"]);
    const queued = result.events[0]!.payload as { message: { references?: unknown } };
    expect(queued.message.references).toEqual(references);
  });

  it("leave no field behind when there are none", () => {
    for (const extra of [{}, { references: [] }]) {
      const result = start(threadDoc(), extra);
      if (!result.accepted) throw new Error("rejected");
      const requested = result.events[0]!.payload as { references?: unknown };
      const upserted = result.events[1]!.payload as { item: { references?: unknown } };
      expect(requested.references).toBeUndefined();
      expect(upserted.item.references).toBeUndefined();
      const queued = start(running, extra);
      if (!queued.accepted) throw new Error("rejected");
      const message = queued.events[0]!.payload as { message: { references?: unknown } };
      expect(message.message.references).toBeUndefined();
    }
  });
});

describe("the thread's connector instance", () => {
  const CHOSEN = makeConnectorInstanceId();
  const OTHER = makeConnectorInstanceId();

  const update = (thread: ThreadDoc, connectorInstanceId = OTHER) =>
    decide(
      {
        ...baseCommand,
        type: "thread.settings.update",
        threadId: thread.threadId,
        connectorInstanceId,
      } as Command,
      { project: null, thread },
      ctx(),
      env,
    );

  const chosenThread = (overrides: Partial<ThreadDoc> = {}) =>
    threadDoc({
      settings: {
        model: "fake/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
        connectorInstanceId: CHOSEN,
      },
      ...overrides,
    });

  it("carries the instance a create command chose onto thread.created", () => {
    const result = decide(
      {
        ...baseCommand,
        type: "thread.create",
        threadId: makeThreadId(),
        projectId: makeProjectId(),
        settings: { connectorInstanceId: CHOSEN },
      } as Command,
      { project: null, thread: null },
      ctx(),
      env,
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const payload = result.events[0]!.payload as { settings: { connectorInstanceId?: string } };
    expect(payload.settings.connectorInstanceId).toBe(CHOSEN);
  });

  it("lets a thread change instance before anything has run", () => {
    const result = update(chosenThread());
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events.map((event) => event.type)).toEqual(["thread.settings.updated"]);
    expect(result.events[0]!.payload).toEqual({ connectorInstanceId: OTHER });
  });

  it("refuses a change once the user has sent a message", () => {
    const thread = chosenThread({
      items: [
        {
          itemId: makeItemId(),
          kind: "user_message",
          status: "completed",
          turnId: makeTurnId(),
          text: "hello",
        },
      ] as ThreadDoc["items"],
    });
    const result = update(thread);
    expect(result).toEqual({
      accepted: false,
      reason: expect.stringContaining("start a new thread to use another connector"),
    });
  });

  it("refuses a change while a session is bound", () => {
    const thread = chosenThread({
      session: { connectorInstanceId: CHOSEN, connectorKind: "fake", sessionRef: {} },
    } as Partial<ThreadDoc>);
    expect(update(thread).accepted).toBe(false);
  });

  it("refuses a change while a turn is running", () => {
    const thread = chosenThread({
      currentTurn: { turnId: makeTurnId(), input: { text: "go", attachments: [], mentions: [] } },
    });
    expect(update(thread).accepted).toBe(false);
  });

  it("accepts the same instance on a locked thread, and leaves it out of the event", () => {
    const thread = chosenThread({
      session: { connectorInstanceId: CHOSEN, connectorKind: "fake", sessionRef: {} },
    } as Partial<ThreadDoc>);
    const result = decide(
      {
        ...baseCommand,
        type: "thread.settings.update",
        threadId: thread.threadId,
        connectorInstanceId: CHOSEN,
        effort: "high",
      } as Command,
      { project: null, thread },
      ctx(),
      env,
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).toEqual({ effort: "high" });
  });

  const pickModel = (thread: ThreadDoc, connectorInstanceId: typeof CHOSEN) =>
    decide(
      {
        ...baseCommand,
        type: "thread.settings.update",
        threadId: thread.threadId,
        model: "fake/other",
        connectorInstanceId,
      } as Command,
      { project: null, thread },
      ctx(),
      env,
    );

  it("switches model on a bound thread that never stored an instance", () => {
    // Threads from before instances could be chosen, or created with no
    // settings, have no `settings.connectorInstanceId` — the session is the
    // only record of where they run.
    const thread = threadDoc({
      session: { connectorInstanceId: CHOSEN, connectorKind: "fake", sessionRef: {} },
    } as Partial<ThreadDoc>);
    const result = pickModel(thread, CHOSEN);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).toEqual({ model: "fake/other" });
  });

  it("switches model on a thread routed away from the instance it stored", () => {
    // It chose CHOSEN, which was not open at its first turn, so it runs on OTHER.
    const thread = chosenThread({
      session: { connectorInstanceId: OTHER, connectorKind: "fake", sessionRef: {} },
    } as Partial<ThreadDoc>);
    const result = pickModel(thread, OTHER);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).toEqual({ model: "fake/other" });
    // Naming the stored-but-unused instance would move the thread: refused.
    expect(pickModel(thread, CHOSEN).accepted).toBe(false);
  });

  it("switches model on a thread that has messages but neither session nor stored instance", () => {
    const thread = threadDoc({
      items: [
        {
          itemId: makeItemId(),
          kind: "user_message",
          status: "completed",
          turnId: makeTurnId(),
          text: "hello",
        },
      ] as ThreadDoc["items"],
    });
    const result = pickModel(thread, CHOSEN);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).toEqual({ model: "fake/other" });
  });
});

describe("steering a running turn", () => {
  const RUNNING = makeTurnId();
  const INSTANCE = makeConnectorInstanceId();

  const capabilities = (steering: boolean): ConnectorCapabilities => ({
    modelSwitch: "per-turn",
    effortSwitch: "per-turn",
    steering,
    planMode: true,
    subagents: true,
    images: false,
    resume: true,
    fork: false,
    interrupt: "turn",
    rollback: false,
    compaction: false,
    questions: true,
    runtimeModes: ["approval-required"],
    attachments: "images",
  });

  /** A thread mid-turn on a session whose harness can, or cannot, steer. */
  const running = (session: ThreadDoc["session"], overrides: Partial<ThreadDoc> = {}) =>
    threadDoc({
      session,
      currentTurn: {
        turnId: RUNNING,
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
      ...overrides,
    });

  const steerable = (overrides: Partial<ThreadDoc> = {}) =>
    running(
      {
        connectorInstanceId: INSTANCE,
        connectorKind: "fake",
        sessionRef: {},
        capabilities: capabilities(true),
      },
      overrides,
    );

  const steer = (
    thread: ThreadDoc | null,
    attachments: ReadonlyArray<{ path: string; mime?: string }> = [],
    context = ctx(),
  ) =>
    decide(
      {
        ...baseCommand,
        type: "thread.turn.steer",
        threadId: thread?.threadId ?? makeThreadId(),
        text: "use port 8081",
        attachments,
        mentions: ["README.md"],
      } as Command,
      { project: null, thread },
      context,
      env,
    );

  it("delivers into the running turn and leaves the user's row to the reactor", () => {
    const attachments = [{ path: "/home/.poseidon/attachments/t/abc-shot.png", mime: "image/png" }];
    const result = steer(steerable(), attachments);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    // The row is written once the message has reached the turn: a steer
    // that misses is started again through the queue, whose turn writes it.
    expect(result.events.map((event) => event.type)).toEqual(["thread.turn.steered"]);
    expect(result.events[0]!.payload).toEqual({
      turnId: RUNNING,
      text: "use port 8081",
      attachments,
      mentions: ["README.md"],
    });
  });

  it("starts a turn when the one it was meant for has already ended", () => {
    const result = steer(threadDoc());
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.turn.requested",
      "thread.item.upserted",
    ]);
    const requested = result.events[0]!.payload as { turnId: string };
    expect(requested.turnId).not.toBe(RUNNING);
  });

  it("queues while the running turn is stopping", () => {
    const result = steer(steerable({ interrupting: true }));
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events.map((event) => event.type)).toEqual(["thread.message.queued"]);
  });

  it("refuses a harness that cannot steer, such as a print-mode one", () => {
    const result = steer(
      running({
        connectorInstanceId: INSTANCE,
        connectorKind: "cmd",
        sessionRef: {},
        capabilities: capabilities(false),
      }),
    );
    expect(result).toEqual({
      accepted: false,
      reason: "this thread's harness cannot take a message mid-turn; queue it instead",
    });
  });

  /** The events a steer became, or its refusal. */
  const outcome = (result: ReturnType<typeof steer>) =>
    result.accepted ? result.events.map((event) => event.type) : result.reason;

  it("queues for a session bound before capabilities were recorded", () => {
    const result = steer(
      running({ connectorInstanceId: INSTANCE, connectorKind: "cmd", sessionRef: {} }),
    );
    expect(outcome(result)).toEqual(["thread.message.queued"]);
  });

  it("queues for a running turn whose session has not bound yet", () => {
    // The thread's first turn, while its harness is still starting: nothing
    // has said whether it steers, and the message waits rather than fails.
    expect(outcome(steer(running(null)))).toEqual(["thread.message.queued"]);
  });

  it("is barred by the same checks as starting a turn", () => {
    const reasons = [
      steer(null),
      steer(steerable({ deleted: true })),
      steer(steerable({ status: "archived" })),
      steer(steerable({ restoring: true })),
      steer(steerable(), [], ctx({ restoreInFlight: () => true })),
    ].map((result) => (result.accepted ? "accepted" : result.reason));
    expect(reasons).toEqual([
      expect.stringContaining("does not exist"),
      expect.stringContaining("does not exist"),
      expect.stringContaining("is archived"),
      expect.stringContaining("restoring a checkpoint"),
      expect.stringContaining("another thread in project"),
    ]);
  });
});

describe("the thread's worktree", () => {
  const create = (worktree?: { path: string; branch: string; baseBranch?: string }) =>
    decide(
      {
        ...baseCommand,
        type: "thread.create",
        threadId: makeThreadId(),
        projectId: makeProjectId(),
        ...(worktree === undefined ? {} : { worktree }),
      } as Command,
      { project: null, thread: null },
      ctx(),
      env,
    );

  it("carries the worktree a create command names onto thread.created", () => {
    const worktree = { path: "/home/dev/.poseidon/worktrees/demo/fix", branch: "poseidon/fix" };
    const result = create({ ...worktree, baseBranch: "main" });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).toMatchObject({
      worktree: { ...worktree, baseBranch: "main" },
    });
  });

  it("leaves a local thread without one", () => {
    const result = create();
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).not.toHaveProperty("worktree");
  });

  it("refuses a worktree path that is not absolute", () => {
    const result = create({ path: "worktrees/fix", branch: "poseidon/fix" });
    expect(result).toEqual({
      accepted: false,
      reason: "worktree path worktrees/fix is not absolute",
    });
  });

  it("asks the restore exclusion about the thread itself", () => {
    const thread = threadDoc({ worktree: { path: "/wt/a", branch: "poseidon/a" } });
    const asked: Array<ThreadDoc> = [];
    decide(
      {
        ...baseCommand,
        type: "thread.turn.start",
        threadId: thread.threadId,
        text: "go",
        attachments: [],
        mentions: [],
        queued: false,
      } as Command,
      { project: null, thread },
      ctx({
        restoreInFlight: (subject) => {
          asked.push(subject);
          return false;
        },
      }),
      env,
    );
    expect(asked).toEqual([thread]);
  });
});

describe("forking a thread", () => {
  const projectId = makeProjectId();
  const instance = makeConnectorInstanceId();
  const [t1, t2] = [makeTurnId(), makeTurnId()];
  const [ask1, answer1, ask2] = [makeItemId(), makeItemId(), makeItemId()];
  const source = threadDoc({
    projectId,
    title: "Health check",
    settings: {
      model: "fake/strong",
      effort: "high",
      runtimeMode: "full-access",
      interactionMode: "plan",
      connectorInstanceId: instance,
    },
    items: [
      { itemId: ask1, kind: "user_message", status: "completed", turnId: t1, text: "Add it." },
      {
        itemId: answer1,
        kind: "assistant_message",
        status: "completed",
        turnId: t1,
        text: "Done.",
      },
      { itemId: ask2, kind: "user_message", status: "completed", turnId: t2, text: "Test it." },
    ],
  });
  const fork = (
    fields: Record<string, unknown> = {},
    forkSource: ThreadDoc | null = source,
    through: string | null = ask1,
  ) =>
    decide(
      {
        ...baseCommand,
        type: "thread.create",
        threadId: makeThreadId(),
        projectId,
        fork: {
          threadId: source.threadId,
          ...(through === null ? {} : { throughItemId: through }),
        },
        ...fields,
      } as Command,
      { project: null, thread: null },
      ctx({ forkSource, defaultModel: null }),
      env,
    );
  const rejection = (result: ReturnType<typeof decide>) => (result.accepted ? null : result.reason);

  it("refuses a source that is missing or deleted", () => {
    expect(rejection(fork({}, null))).toContain("to fork does not exist");
    expect(rejection(fork({}, { ...source, deleted: true }))).toContain("to fork does not exist");
  });

  it("refuses a source in another project", () => {
    expect(rejection(fork({}, { ...source, projectId: makeProjectId() }))).toContain(
      "belongs to another project",
    );
  });

  it("refuses an item that is not one of the source's user messages", () => {
    expect(rejection(fork({}, source, answer1))).toContain("is not a message of thread");
    expect(rejection(fork({}, source, makeItemId()))).toContain("is not a message of thread");
  });

  it("refuses a message of the turn still running", () => {
    const running = {
      ...source,
      status: "running" as const,
      currentTurn: { turnId: t2, input: { text: "Test it.", attachments: [], mentions: [] } },
    };
    expect(rejection(fork({}, running, ask2))).toBe(
      "cannot fork from a turn that is still running",
    );
    // An earlier, settled turn of the same thread still forks.
    expect(fork({}, running, ask1).accepted).toBe(true);
  });

  it("refuses the whole thread while a turn is running", () => {
    const running = {
      ...source,
      status: "running" as const,
      currentTurn: { turnId: t2, input: { text: "Test it.", attachments: [], mentions: [] } },
    };
    expect(rejection(fork({}, running, null))).toBe("cannot fork a thread while a turn is running");
  });

  it("titles the fork after its source and starts from the source's settings, out of plan mode", () => {
    const result = fork();
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).toMatchObject({
      title: "Health check (fork)",
      settings: {
        model: "fake/strong",
        effort: "high",
        runtimeMode: "full-access",
        interactionMode: "default",
        connectorInstanceId: instance,
      },
    });
  });

  it("lets the command's own title and settings win", () => {
    const result = fork({ title: "Try another way", settings: { model: "fake/quick" } });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).toMatchObject({
      title: "Try another way",
      settings: { model: "fake/quick", effort: "high", runtimeMode: "full-access" },
    });
  });

  it("records the fork with the transcript through the message's turn", () => {
    const result = fork();
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).toMatchObject({
      fork: {
        threadId: source.threadId,
        title: "Health check",
        throughItemId: ask1,
        transcript: "User:\nAdd it.\n\nAssistant:\nDone.",
      },
    });
  });

  it("carries the whole thread when no message is named", () => {
    const result = fork({}, source, null);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const payload = result.events[0]!.payload as { fork: Record<string, unknown> };
    expect(payload.fork).not.toHaveProperty("throughItemId");
    expect(payload.fork.transcript).toBe("User:\nAdd it.\n\nAssistant:\nDone.\n\nUser:\nTest it.");
  });

  describe("natively, when the harness can", () => {
    const sessionRef = { sessionId: "source-session" };
    const bound = (fork: boolean): ThreadDoc["session"] => ({
      connectorInstanceId: instance,
      connectorKind: "cmd",
      sessionRef,
      capabilities: {
        modelSwitch: "per-turn",
        effortSwitch: "per-turn",
        steering: false,
        planMode: true,
        subagents: true,
        images: true,
        resume: true,
        fork,
        interrupt: "turn",
        rollback: false,
        compaction: false,
        questions: true,
        runtimeModes: ["approval-required"],
        attachments: "files",
      },
    });
    const forkable = { ...source, session: bound(true) };
    const sessionOf = (result: ReturnType<typeof decide>) =>
      result.accepted
        ? (result.events[0]!.payload as { fork: { session?: unknown } }).fork.session
        : "rejected";

    it("records the source's session for a fork of its latest turn", () => {
      const result = fork({}, forkable, ask2);
      expect(sessionOf(result)).toEqual({
        connectorInstanceId: instance,
        sessionRef,
        afterTurnId: t2,
      });
      // The transcript is kept anyway, for when the harness cannot fork after all.
      expect(result.accepted && result.events[0]!.payload).toMatchObject({
        fork: { transcript: expect.stringContaining("User:\nTest it.") },
        settings: { connectorInstanceId: instance },
      });
    });

    it("records it for a fork of the whole thread", () => {
      expect(sessionOf(fork({}, forkable, null))).toEqual({
        connectorInstanceId: instance,
        sessionRef,
        afterTurnId: t2,
      });
    });

    it("copies a fork of an earlier turn", () => {
      expect(sessionOf(fork({}, forkable, ask1))).toBeUndefined();
    });

    it("copies when the harness cannot fork, or no session is bound", () => {
      expect(sessionOf(fork({}, { ...source, session: bound(false) }, ask2))).toBeUndefined();
      expect(sessionOf(fork({}, source, ask2))).toBeUndefined();
    });

    it("copies while the source is running", () => {
      const running = {
        ...forkable,
        status: "running" as const,
        currentTurn: {
          turnId: makeTurnId(),
          input: { text: "More.", attachments: [], mentions: [] },
        },
      };
      expect(sessionOf(fork({}, running, ask2))).toBeUndefined();
    });

    it("copies onto another connector instance", () => {
      const other = makeConnectorInstanceId();
      const result = fork({ settings: { connectorInstanceId: other } }, forkable, ask2);
      expect(sessionOf(result)).toBeUndefined();
      expect(result.accepted && result.events[0]!.payload).toMatchObject({
        settings: { connectorInstanceId: other },
      });
    });

    it("copies into a workspace other than the source's", () => {
      const worktree = { path: "/repo/.worktrees/other", branch: "other" };
      expect(sessionOf(fork({ worktree }, forkable, ask2))).toBeUndefined();
      // The source's own worktree is the source's workspace: still native.
      const inWorktree = { ...forkable, worktree };
      expect(sessionOf(fork({ worktree }, inWorktree, ask2))).toEqual({
        connectorInstanceId: instance,
        sessionRef,
        afterTurnId: t2,
      });
    });
  });

  it("leaves a thread that is not a fork without one", () => {
    const result = decide(
      { ...baseCommand, type: "thread.create", threadId: makeThreadId(), projectId } as Command,
      { project: null, thread: null },
      ctx(),
      env,
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events[0]!.payload).not.toHaveProperty("fork");
  });
});

describe("editing and resending a message", () => {
  const checkpoints = [
    {
      checkpointId: "cp-1" as never,
      turnId: makeTurnId(),
      ref: "refs/ade/checkpoint/cp-1",
      createdAt: NOW,
    },
  ];
  const resend = {
    text: "Use /livez instead.",
    attachments: [],
    mentions: ["src/health.ts"],
    references: [{ kind: "skill" as const, name: "health-checks" }],
  };
  const restore = (withResend: boolean) =>
    ({
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
      ...(withResend ? { resend } : {}),
    }) as unknown as Command;

  it("carries the edited message on the work order", () => {
    const result = decide(
      restore(true),
      { project: null, thread: threadDoc({ checkpoints }) },
      ctx(),
      env,
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      const [order] = result.events;
      expect(order?.type).toBe("thread.checkpoint.restore.requested");
      expect(order?.payload).toEqual({ checkpoint: checkpoints[0], resend });
    }
  });

  it("leaves a plain restore's work order without one", () => {
    const result = decide(
      restore(false),
      { project: null, thread: threadDoc({ checkpoints }) },
      ctx(),
      env,
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.events[0]?.payload).toEqual({ checkpoint: checkpoints[0] });
    }
  });

  it("is refused while a turn runs, like any restore", () => {
    const thread = threadDoc({
      checkpoints,
      status: "running",
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
    });
    const result = decide(restore(true), { project: null, thread }, ctx(), env);
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain("running turn");
    }
  });
});
