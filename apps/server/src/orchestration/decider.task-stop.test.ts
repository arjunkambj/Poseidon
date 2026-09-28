/**
 * `thread.task.stop`: one running subagent stopped while its turn goes on,
 * accepted only for a task of the running turn on a session that says its
 * harness can stop one.
 */

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
import type { ConnectorCapabilities, ItemSnapshot } from "@poseidon/contracts/runtime";

import { decide, type DeciderContext, type DecideEnv } from "./decider";
import type { ThreadDoc } from "./state";

const NOW = "2026-01-02T03:04:05.000Z";

const env: DecideEnv = {
  now: NOW,
  nextEventId: makeEventId,
  nextTurnId: makeTurnId,
  nextItemId: makeItemId,
};

const ctx: DeciderContext = {
  projectExists: () => true,
  workspaceRootTaken: () => false,
  restoreInFlight: () => false,
  defaultModel: "fake/model",
  defaultEffort: null,
  defaultRuntimeMode: null,
};

const RUNNING = makeTurnId();
const EARLIER = makeTurnId();

const capabilities = (stopTask: boolean | undefined): ConnectorCapabilities => ({
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  steering: false,
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
  ...(stopTask === undefined ? {} : { stopTask }),
});

const task = (fields: Partial<ItemSnapshot> = {}): ItemSnapshot => ({
  itemId: makeItemId(),
  kind: "task",
  status: "in_progress",
  turnId: RUNNING,
  text: "Explore",
  ...fields,
});

/** A thread mid-turn on a session that can, or cannot, stop a subagent. */
const thread = (
  items: ReadonlyArray<ItemSnapshot>,
  stopTask: boolean | undefined,
  overrides: Partial<ThreadDoc> = {},
): ThreadDoc => ({
  threadId: makeThreadId(),
  projectId: makeProjectId(),
  title: "Thread",
  status: "running",
  settings: { model: "fake/model", runtimeMode: "approval-required", interactionMode: "default" },
  worktree: null,
  snapshotSequence: 1,
  items,
  queue: [],
  checkpoints: [],
  session: {
    connectorInstanceId: makeConnectorInstanceId(),
    connectorKind: "fake",
    sessionRef: {},
    capabilities: capabilities(stopTask),
  },
  currentTurn: { turnId: RUNNING, input: { text: "go", attachments: [], mentions: [] } },
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

const stop = (doc: ThreadDoc, itemId: string) =>
  decide(
    {
      commandId: makeCommandId(),
      createdAt: NOW,
      type: "thread.task.stop",
      threadId: doc.threadId,
      itemId,
    } as Command,
    { project: null, thread: doc },
    ctx,
    env,
  );

const reasonOf = (result: ReturnType<typeof decide>) => (result.accepted ? null : result.reason);

describe("thread.task.stop", () => {
  it("asks for a running subagent of the running turn to stop", () => {
    const running = task();
    const result = stop(thread([running], true), running.itemId);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.events.map((event) => [event.type, event.payload])).toEqual([
      ["thread.task.stopRequested", { itemId: running.itemId }],
    ]);
  });

  it("refuses when the harness has not said it can stop a subagent", () => {
    const running = task();
    expect(reasonOf(stop(thread([running], false), running.itemId))).toContain(
      "cannot stop a subagent",
    );
    expect(reasonOf(stop(thread([running], undefined), running.itemId))).toContain(
      "cannot stop a subagent",
    );
  });

  it("refuses a task that is not running in the running turn", () => {
    const settled = task({ status: "completed" });
    const stranded = task({ turnId: EARLIER });
    const notTask = task({ kind: "tool_call" });
    const doc = thread([settled, stranded, notTask], true);
    for (const item of [settled, stranded, notTask]) {
      expect(reasonOf(stop(doc, item.itemId))).toContain("is not a running subagent");
    }
    expect(reasonOf(stop(doc, makeItemId()))).toContain("is not a running subagent");
  });

  it("refuses once the turn has ended", () => {
    const running = task();
    const doc = thread([running], true, { currentTurn: null, status: "idle" });
    expect(reasonOf(stop(doc, running.itemId))).toContain("is not a running subagent");
  });
});
