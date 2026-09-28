/**
 * The thread fold, driven straight from event sequences.
 *
 * Every case here is a state the decider later reads back — a fold that gets
 * one of them wrong wedges a thread rather than merely showing it wrong.
 */

import { describe, expect, it } from "vitest";

import {
  makeCheckpointId,
  makeConnectorInstanceId,
  makeEventId,
  makeItemId,
  makeProjectId,
  makeRequestId,
  makeThreadId,
  makeTurnId,
} from "@poseidon/contracts/ids";
import { UNANSWERED_OUTCOME } from "@poseidon/contracts/decisions";
import type { CheckpointSummary, OrchestrationEvent } from "@poseidon/contracts/orchestration";
import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

import { doneAtOf, lastActivityOf } from "./threadDone";
import {
  foldThread,
  projectThreadEvent,
  threadSnapshotOf,
  threadSummaryOf,
  worktreeOf,
  type ThreadDoc,
} from "./state";

const NOW = "2026-01-02T03:04:05.000Z";

const projectId = makeProjectId();
const threadId = makeThreadId();

let sequence = 0;

const event = <Type extends OrchestrationEvent["type"]>(
  type: Type,
  payload: Extract<OrchestrationEvent, { type: Type }>["payload"],
): OrchestrationEvent => {
  sequence += 1;
  return {
    sequence,
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    streamVersion: sequence,
    occurredAt: NOW,
    actor: "system",
    type,
    payload,
  } as OrchestrationEvent;
};

/** The same event as the runtime ingestion writes it: from the connector. */
const fromConnector = (planned: OrchestrationEvent): OrchestrationEvent => ({
  ...planned,
  actor: "connector",
});

const created = () =>
  event("thread.created", {
    threadId,
    projectId,
    title: "Thread",
    settings: {
      model: "fake/model",
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
  });

const turnRequested = (turnId = makeTurnId()) =>
  event("thread.turn.requested", { turnId, text: "hello", attachments: [], mentions: [] });

const steeringCapabilities: ConnectorCapabilities = {
  modelSwitch: "in-session",
  effortSwitch: "in-session",
  steering: true,
  planMode: true,
  subagents: true,
  images: true,
  resume: true,
  fork: false,
  interrupt: "turn",
  rollback: false,
  compaction: true,
  questions: true,
  runtimeModes: ["approval-required"],
  attachments: "images",
};

const checkpoint: CheckpointSummary = {
  checkpointId: makeCheckpointId(),
  turnId: makeTurnId(),
  ref: "refs/poseidon/checkpoints/thread/turn",
  createdAt: NOW,
};

describe("the thread fold", () => {
  it("clears the in-flight turn when the session is lost", () => {
    const doc = foldThread([
      created(),
      turnRequested(),
      event("thread.session.lost", { reason: "connector binary is missing" }),
    ]);

    // The turn can never complete — the process that would complete it is
    // gone — so leaving `currentTurn` set would wedge the thread forever.
    expect(doc?.currentTurn).toBeNull();
    expect(doc?.session).toBeNull();
    expect(doc?.status).toBe("error");
  });

  it("keeps a queued message across a lost session", () => {
    const doc = foldThread([
      created(),
      turnRequested(),
      event("thread.message.queued", {
        message: {
          queuedMessageId: makeItemId(),
          text: "queued",
          attachments: [],
          mentions: [],
          queuedAt: NOW,
        },
      }),
      event("thread.session.lost", { reason: "resume budget ran out" }),
    ]);

    expect(doc?.queue).toHaveLength(1);
  });

  it("drops the questions a lost session left open", () => {
    const requestId = makeRequestId();
    const doc = foldThread([
      created(),
      turnRequested(),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm run build" },
          description: "Run npm run build",
        },
      }),
      event("thread.session.lost", { reason: "connector binary is missing" }),
    ]);

    // The process that asked is gone, so the answer has nowhere to go. Leaving
    // the card up would keep the thread reading "waiting for you" with nothing
    // the user can do about it — the same wedge `currentTurn` is cleared for.
    expect(doc?.approvals).toEqual([]);
    expect(doc?.userInputs).toEqual([]);
  });

  it("goes back to idle once an answered plan is the last card up", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
      event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
      event("thread.plan.responded", { turnId, action: "revise" }),
    ]);

    // Nothing is open and no turn is running, so the thread is idle. Reading
    // the pre-event document here left it parked on "waiting" over the plan it
    // had just answered, until the next turn moved it.
    expect(doc?.pendingPlan).toBeNull();
    expect(doc?.status).toBe("idle");
  });

  it("keeps the turn's references for a resume to re-send, and none from an old event", () => {
    const references = [{ kind: "skill" as const, name: "release-notes" }];
    const withReferences = foldThread([
      created(),
      event("thread.turn.requested", {
        turnId: makeTurnId(),
        text: "hello",
        attachments: [],
        mentions: [],
        references,
      }),
    ]);
    // Written before references existed: the field is simply absent.
    const old = foldThread([created(), turnRequested()]);

    expect(withReferences?.currentTurn?.input.references).toEqual(references);
    expect(old?.currentTurn?.input.references).toEqual([]);
  });

  it("keeps the in-flight turn while an interrupt settles", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.turn.interrupted", { turnId }),
    ]);

    // The connector has not stopped yet: the turn-scoped handle answers
    // "busy" to anything sent before it emits this turn's `turn.completed`.
    expect(doc?.currentTurn?.turnId).toBe(turnId);
    expect(doc?.interrupting).toBe(true);
    expect(doc?.status).toBe("running");
  });

  it("settles the interrupt on the connector's turn.completed", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.turn.interrupted", { turnId }),
      event("thread.turn.completed", { turnId, stopReason: "interrupted" }),
    ]);

    expect(doc?.currentTurn).toBeNull();
    expect(doc?.interrupting).toBe(false);
    expect(doc?.status).toBe("idle");
  });

  it("puts an archived idle thread back to idle on unarchive", () => {
    const doc = foldThread([
      created(),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
    ]);

    expect(doc?.status).toBe("idle");
    expect(doc?.currentTurn).toBeNull();
  });

  it("drops the cards an archive left open when the thread is unarchived", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.approval.opened", {
        request: {
          requestId: makeRequestId(),
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm run build" },
          description: "Run npm run build",
        },
      }),
      event("thread.userInput.requested", {
        requestId: makeRequestId(),
        questions: [{ questionId: "q1", question: "Which one?", options: [] }],
      }),
      event("thread.archived", {}),
      event("thread.turn.completed", { turnId, stopReason: "interrupted" }),
      event("thread.unarchived", {}),
    ]);

    // Archiving closed the session, so whoever asked is gone: leaving the
    // cards up would park the thread on "waiting" with nothing to answer.
    expect(doc?.approvals).toEqual([]);
    expect(doc?.userInputs).toEqual([]);
    expect(doc?.status).toBe("idle");
  });

  it("keeps the session across an unarchive so the next turn resumes it", () => {
    const doc = foldThread([
      created(),
      event("thread.session.bound", {
        connectorInstanceId: makeConnectorInstanceId(),
        connectorKind: "fake",
        sessionRef: { id: "session-1" },
      }),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
    ]);

    expect(doc?.session?.sessionRef).toEqual({ id: "session-1" });
  });

  it("ignores the late settlement of a turn an archive closed once a newer turn runs", () => {
    const first = makeTurnId();
    const second = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(first),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
      turnRequested(second),
      // The close the archive asked for settles the first turn only now.
      event("thread.turn.completed", { turnId: first, stopReason: "interrupted" }),
    ]);

    // Ending the second turn here would let the next send start a turn the
    // connector answers "busy" to, instead of queueing it.
    expect(doc?.currentTurn?.turnId).toBe(second);
    expect(doc?.status).toBe("running");

    const settled = foldThread([
      created(),
      turnRequested(first),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
      turnRequested(second),
      event("thread.turn.completed", { turnId: first, stopReason: "interrupted" }),
      event("thread.turn.completed", { turnId: second, stopReason: "end_turn" }),
    ]);
    expect(settled?.currentTurn).toBeNull();
    expect(settled?.status).toBe("idle");
  });

  it("keeps a pending plan across an unarchive and waits on it", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
      event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
    ]);

    // Answering the plan starts a new turn, so it still has somewhere to go.
    expect(doc?.pendingPlan).not.toBeNull();
    expect(doc?.status).toBe("waiting");
  });

  it("marks a thread as restoring between the work order and its outcome", () => {
    const requested = foldThread([
      created(),
      event("thread.checkpoint.created", { checkpoint }),
      event("thread.checkpoint.restore.requested", { checkpoint }),
    ]);
    expect(requested?.restoring).toBe(true);
    // Which checkpoint, not only that one is running: `threadSnapshotOf` puts
    // it on the wire so a client that reloads mid-restore keeps the spinner up
    // and the Restore button disabled.
    expect(requested?.restoringCheckpoint).toEqual(checkpoint);
    expect(threadSnapshotOf(requested!).restoring).toEqual(checkpoint);

    const done = foldThread([
      created(),
      event("thread.checkpoint.created", { checkpoint }),
      event("thread.checkpoint.restore.requested", { checkpoint }),
      event("thread.checkpoint.restored", { checkpoint }),
    ]);
    expect(done?.restoring).toBe(false);
    expect(done?.restoringCheckpoint).toBeNull();
    expect(threadSnapshotOf(done!).restoring).toBeNull();

    const failed = foldThread([
      created(),
      event("thread.checkpoint.created", { checkpoint }),
      event("thread.checkpoint.restore.requested", { checkpoint }),
      event("thread.checkpoint.restore.failed", {
        checkpointId: checkpoint.checkpointId,
        message: "the worktree is locked",
      }),
    ]);
    expect(failed?.restoring).toBe(false);
    expect(failed?.restoringCheckpoint).toBeNull();
    expect(threadSnapshotOf(failed!).restoring).toBeNull();
  });

  it("records each restore that went through after the thread's latest turn", () => {
    const [first, second] = [makeTurnId(), makeTurnId()];
    const message = (turnId: typeof first) =>
      event("thread.item.upserted", {
        item: { itemId: makeItemId(), kind: "user_message", status: "completed", text: "go" },
        turnId,
      });
    const firstCheckpoint = { ...checkpoint, turnId: first };
    const doc = foldThread([
      created(),
      turnRequested(first),
      message(first),
      event("thread.turn.completed", { turnId: first, stopReason: "end_turn" }),
      event("thread.checkpoint.created", { checkpoint: firstCheckpoint }),
      turnRequested(second),
      message(second),
      event("thread.turn.completed", { turnId: second, stopReason: "end_turn" }),
      event("thread.checkpoint.restore.requested", { checkpoint: firstCheckpoint }),
      // A refused restore moved nothing, and is not recorded.
      event("thread.checkpoint.restore.failed", {
        checkpointId: firstCheckpoint.checkpointId,
        message: "the worktree is locked",
      }),
      event("thread.checkpoint.restore.requested", { checkpoint: firstCheckpoint }),
      event("thread.checkpoint.restored", { checkpoint: firstCheckpoint }),
    ]);
    // The next turn starts from the first turn's checkpoint, not the second's.
    const restores = [{ checkpoint: firstCheckpoint, afterTurnId: second }];
    expect(doc?.restores).toEqual(restores);
    expect(threadSnapshotOf(doc!).restores).toEqual(restores);
  });

  it("reads a document stored before restores were kept as having none", () => {
    const { restores: _restores, ...older } = foldThread([created()])!;
    const stored = older as unknown as ThreadDoc;
    expect(threadSnapshotOf(stored).restores).toEqual([]);
    const next = projectThreadEvent(stored, event("thread.checkpoint.restored", { checkpoint }));
    expect(next?.restores).toEqual([{ checkpoint, afterTurnId: null }]);
  });

  it("stamps each stored item with the turn that produced it", () => {
    const turnId = makeTurnId();
    const itemId = makeItemId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.item.upserted", {
        item: { itemId, kind: "assistant_message", status: "in_progress" },
        turnId,
      }),
      event("thread.item.upserted", {
        item: { itemId, kind: "assistant_message", status: "completed", text: "hi" },
        turnId,
      }),
    ]);

    // One row, still carrying its turn — a snapshot with no turn boundaries
    // cannot be grouped into settled turns by a client that joins late.
    expect(doc?.items).toHaveLength(1);
    expect(doc?.items[0]?.turnId).toBe(turnId);
  });

  it("keeps a stored item's turn when a later upsert carries none", () => {
    const turnId = makeTurnId();
    const itemId = makeItemId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.item.upserted", {
        item: { itemId, kind: "tool_call", status: "in_progress" },
        turnId,
      }),
      // A tool row finalised after the turn's scope closed: ingestion has no
      // turn to stamp, and the row must not lose the one it already had.
      event("thread.item.upserted", {
        item: { itemId, kind: "tool_call", status: "completed" },
      }),
    ]);

    expect(doc?.items).toHaveLength(1);
    expect(doc?.items[0]?.status).toBe("completed");
    expect(doc?.items[0]?.turnId).toBe(turnId);
  });

  it("records the connector instance a settings patch chose, and keeps it after", () => {
    const chosen = makeConnectorInstanceId();
    const doc = foldThread([
      created(),
      event("thread.settings.updated", { connectorInstanceId: chosen }),
      // A later patch that says nothing about the connector leaves it alone.
      event("thread.settings.updated", { effort: "high" }),
    ]);

    expect(doc?.settings.connectorInstanceId).toBe(chosen);
    expect(doc?.settings.effort).toBe("high");
  });

  it("leaves a thread that never chose an instance without one", () => {
    const doc = foldThread([created(), event("thread.settings.updated", { effort: "low" })]);

    expect(doc?.settings).not.toHaveProperty("connectorInstanceId");
  });

  it("stores the capabilities a session was bound with, and serves them", () => {
    const doc = foldThread([
      created(),
      event("thread.session.bound", {
        connectorInstanceId: makeConnectorInstanceId(),
        connectorKind: "fake",
        sessionRef: { id: "session-1" },
        capabilities: steeringCapabilities,
      }),
    ]);

    expect(doc?.session?.capabilities?.steering).toBe(true);
    expect(doc === null ? null : threadSnapshotOf(doc).session?.capabilities).toEqual(
      steeringCapabilities,
    );
  });

  it("binds a session recorded without capabilities as one that cannot steer", () => {
    const doc = foldThread([
      created(),
      event("thread.session.bound", {
        connectorInstanceId: makeConnectorInstanceId(),
        connectorKind: "fake",
        sessionRef: { id: "session-1" },
      }),
    ]);

    expect(doc?.session).not.toHaveProperty("capabilities");
  });

  it("changes nothing on a steered message: the turn it joined keeps running", () => {
    const turnId = makeTurnId();
    const before = foldThread([created(), turnRequested(turnId)]);
    const steered = event("thread.turn.steered", {
      turnId,
      text: "use port 8081",
      attachments: [],
      mentions: [],
    });
    const after = before === null ? null : projectThreadEvent(before, steered);

    expect(after).toEqual({
      ...before,
      snapshotSequence: steered.sequence,
      updatedAt: steered.occurredAt,
    });
    expect(after?.currentTurn?.turnId).toBe(turnId);
    expect(after?.items).toEqual([]);
  });
});

describe("the decision record", () => {
  const upserted = (itemId = makeItemId()) =>
    event("thread.item.upserted", {
      item: { itemId, kind: "assistant_message", status: "completed", text: "hi" },
    });

  it("records an answered approval with its target and the pattern kept", () => {
    const requestId = makeRequestId();
    const lastItem = makeItemId();
    const doc = foldThread([
      created(),
      turnRequested(),
      upserted(),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm run build\n--verbose" },
          description: "Run npm run build",
        },
      }),
      upserted(lastItem),
      event("thread.approval.resolved", {
        requestId,
        decision: "allow-always",
        pattern: "Shell(npm run *)",
      }),
    ]);

    expect(doc?.approvals).toEqual([]);
    expect(doc?.decisions).toEqual([
      {
        kind: "approval",
        id: requestId,
        outcome: "allow-always",
        subject: "npm run build",
        pattern: "Shell(npm run *)",
        resolvedAt: NOW,
        afterItemId: lastItem,
      },
    ]);
    expect(threadSnapshotOf(doc!).decisions).toEqual(doc?.decisions);
  });

  it("records an answered question by its first header", () => {
    const requestId = makeRequestId();
    const lastItem = makeItemId();
    const doc = foldThread([
      created(),
      turnRequested(),
      upserted(lastItem),
      event("thread.userInput.requested", {
        requestId,
        questions: [
          { questionId: "db", question: "Which database?", header: "Database", options: [] },
          { questionId: "port", question: "Which port?", options: [] },
        ],
      }),
      event("thread.userInput.resolved", {
        requestId,
        answers: [{ questionId: "db", optionIds: [], text: "sqlite" }],
      }),
    ]);

    expect(doc?.decisions).toEqual([
      {
        kind: "question",
        id: requestId,
        outcome: "answered",
        subject: "Database",
        resolvedAt: NOW,
        afterItemId: lastItem,
      },
    ]);
  });

  it("records an answered plan by its file name", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.plan.proposed", {
        turnId,
        planMarkdown: "# plan",
        planPath: "/work/plans/health-check.md",
      }),
      event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
      event("thread.plan.responded", { turnId, action: "accept-auto" }),
    ]);

    // No item landed before the answer, so the record has nothing to follow.
    expect(doc?.decisions).toEqual([
      {
        kind: "plan",
        id: turnId,
        outcome: "accept-auto",
        subject: "health-check.md",
        resolvedAt: NOW,
      },
    ]);
  });

  it("keeps one line per answer when the connector echoes it", () => {
    const requestId = makeRequestId();
    const questionId = makeRequestId();
    const doc = foldThread([
      created(),
      turnRequested(),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls" },
          description: "Run ls",
        },
      }),
      event("thread.approval.resolved", { requestId, decision: "deny" }),
      // The connector's own `request.resolved`, arriving after the decider's.
      fromConnector(event("thread.approval.resolved", { requestId, decision: "deny" })),
      event("thread.userInput.requested", {
        requestId: questionId,
        questions: [{ questionId: "q", question: "Which port?", options: [] }],
      }),
      event("thread.userInput.resolved", {
        requestId: questionId,
        answers: [{ questionId: "q", optionIds: [], text: "8080" }],
      }),
      fromConnector(event("thread.userInput.resolved", { requestId: questionId, answers: [] })),
    ]);

    expect(
      doc?.decisions.map((decision) => [decision.kind, decision.id, decision.outcome]),
    ).toEqual([
      ["approval", requestId, "deny"],
      ["question", questionId, "answered"],
    ]);
  });

  it("records a card the runtime released on exit as not answered", () => {
    const requestId = makeRequestId();
    const questionId = makeRequestId();
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm test" },
          description: "Run npm test",
        },
      }),
      event("thread.userInput.requested", {
        requestId: questionId,
        questions: [{ questionId: "q", header: "Database", question: "Which one?", options: [] }],
      }),
      // Stop kills the process; the connector releases both parked requests
      // before anyone answered them.
      event("thread.turn.interrupted", { turnId }),
      fromConnector(event("thread.approval.resolved", { requestId, decision: "deny" })),
      fromConnector(event("thread.userInput.resolved", { requestId: questionId, answers: [] })),
    ]);

    expect(
      doc?.decisions.map((decision) => [decision.kind, decision.outcome, decision.subject]),
    ).toEqual([
      ["approval", UNANSWERED_OUTCOME, "npm test"],
      ["question", UNANSWERED_OUTCOME, "Database"],
    ]);
    expect(doc?.approvals).toEqual([]);
    expect(doc?.userInputs).toEqual([]);
  });

  it("serves a document projected before decisions were kept", () => {
    const requestId = makeRequestId();
    const current = foldThread([
      created(),
      turnRequested(),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls" },
          description: "Run ls",
        },
      }),
    ])!;
    // A row an older projector wrote: the field is simply not there.
    const { decisions: _decisions, ...older } = current;
    const stored = older as unknown as ThreadDoc;

    expect(threadSnapshotOf(stored).decisions).toEqual([]);
    const next = projectThreadEvent(
      stored,
      event("thread.approval.resolved", { requestId, decision: "allow-once" }),
    );
    expect(next?.decisions.map((decision) => decision.id)).toEqual([requestId]);
  });
});

describe("what a thread is waiting on", () => {
  it("names the most urgent open card: approval, then question, then plan", () => {
    const turnId = makeTurnId();
    const approvalId = makeRequestId();
    const questionId = makeRequestId();
    const events = [
      created(),
      turnRequested(turnId),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
      event("thread.userInput.requested", {
        requestId: questionId,
        questions: [{ questionId: "q", question: "Which port?", options: [] }],
      }),
      event("thread.approval.opened", {
        request: {
          requestId: approvalId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls" },
          description: "Run ls",
        },
      }),
    ];
    const summaryAfter = (count: number) => threadSummaryOf(foldThread(events.slice(0, count))!);

    expect(summaryAfter(2).awaitingInput).toBe(false);
    expect(summaryAfter(2)).not.toHaveProperty("awaiting");
    expect(summaryAfter(3).awaiting).toBe("plan");
    expect(summaryAfter(4).awaiting).toBe("question");
    expect(summaryAfter(5).awaiting).toBe("approval");
    expect(summaryAfter(5).awaitingInput).toBe(true);

    // Answering the approval hands the row back to the question behind it.
    const answered = foldThread([
      ...events,
      event("thread.approval.resolved", { requestId: approvalId, decision: "allow-once" }),
    ])!;
    expect(threadSummaryOf(answered).awaiting).toBe("question");
  });
});

describe("what a running turn is doing", () => {
  it("is thinking until a tool row is in flight, working while one is", () => {
    const turnId = makeTurnId();
    const reasoning = makeItemId();
    const command = makeItemId();
    const upsert = (
      itemId: typeof command,
      kind: "reasoning" | "command_execution",
      done: boolean,
    ) =>
      event("thread.item.upserted", {
        turnId,
        item: { itemId, kind, status: done ? "completed" : "in_progress" },
      });
    const events = [
      created(),
      turnRequested(turnId),
      upsert(reasoning, "reasoning", false),
      upsert(reasoning, "reasoning", true),
      upsert(command, "command_execution", false),
      upsert(command, "command_execution", true),
      event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
    ];
    const activityAfter = (count: number) =>
      threadSummaryOf(foldThread(events.slice(0, count))!).activity;

    expect(activityAfter(1)).toBeUndefined();
    expect(activityAfter(2)).toBe("thinking");
    expect(activityAfter(3)).toBe("thinking");
    expect(activityAfter(5)).toBe("working");
    expect(activityAfter(6)).toBe("thinking");
    expect(activityAfter(7)).toBeUndefined();
  });
});

describe("since when a running thread has been working", () => {
  const REQUESTED = "2026-01-02T03:10:00.000Z";
  const at = (occurredAt: string, planned: OrchestrationEvent): OrchestrationEvent => ({
    ...planned,
    occurredAt,
  });

  it("stamps the request time and keeps it for the whole turn", () => {
    const turnId = makeTurnId();
    const itemId = makeItemId();
    const events = [
      created(),
      at(REQUESTED, turnRequested(turnId)),
      at("2026-01-02T03:10:02.000Z", event("thread.turn.started", { turnId })),
      at(
        "2026-01-02T03:12:00.000Z",
        event("thread.item.upserted", {
          turnId,
          item: { itemId, kind: "command_execution", status: "in_progress" },
        }),
      ),
      at(
        "2026-01-02T03:15:00.000Z",
        event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
      ),
    ];
    const summaryAfter = (count: number) => threadSummaryOf(foldThread(events.slice(0, count))!);

    expect(summaryAfter(1)).not.toHaveProperty("runningSince");
    expect(summaryAfter(2).runningSince).toBe(REQUESTED);
    expect(summaryAfter(3).runningSince).toBe(REQUESTED);
    expect(summaryAfter(4).runningSince).toBe(REQUESTED);
    // `updatedAt` moves on every event; the turn's start does not.
    expect(summaryAfter(4).updatedAt).not.toBe(REQUESTED);
    expect(summaryAfter(5).status).toBe("idle");
    expect(summaryAfter(5)).not.toHaveProperty("runningSince");
  });

  it("is absent while the thread waits on the user or has failed", () => {
    const turnId = makeTurnId();
    const waiting = foldThread([
      created(),
      at(REQUESTED, turnRequested(turnId)),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
    ])!;
    expect(waiting.status).toBe("waiting");
    expect(threadSummaryOf(waiting)).not.toHaveProperty("runningSince");

    const failed = foldThread([
      created(),
      at(REQUESTED, turnRequested(turnId)),
      event("thread.error", { message: "the connector failed", fatal: true }),
    ])!;
    expect(failed.status).toBe("error");
    expect(threadSummaryOf(failed)).not.toHaveProperty("runningSince");
  });

  it("is absent for a turn folded before the field existed", () => {
    const doc = foldThread([created(), turnRequested()])!;
    const { startedAt: _startedAt, ...turn } = doc.currentTurn!;
    const stored = { ...doc, currentTurn: turn } as ThreadDoc;
    expect(stored.status).toBe("running");
    expect(threadSummaryOf(stored)).not.toHaveProperty("runningSince");
  });
});

describe("the thread's worktree", () => {
  const worktree = { path: "/wt/demo/fix", branch: "poseidon/fix", baseBranch: "main" };

  const createdIn = () =>
    event("thread.created", {
      threadId,
      projectId,
      title: "Thread",
      settings: {
        model: "fake/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
      worktree,
    });

  it("folds the worktree from thread.created onto the summary and the snapshot", () => {
    const doc = foldThread([createdIn(), turnRequested()])!;
    expect(doc.worktree).toEqual(worktree);
    expect(threadSummaryOf(doc).worktree).toEqual(worktree);
    expect(threadSnapshotOf(doc).worktree).toEqual(worktree);
  });

  it("leaves a local thread without one, on the wire as well", () => {
    const doc = foldThread([created()])!;
    expect(doc.worktree).toBeNull();
    expect(threadSummaryOf(doc)).not.toHaveProperty("worktree");
    expect(threadSnapshotOf(doc)).not.toHaveProperty("worktree");
  });

  it("reads a document projected before threads had one as local", () => {
    const { worktree: _worktree, ...older } = foldThread([created()])!;
    const stored = JSON.parse(JSON.stringify(older)) as ThreadDoc;
    expect(worktreeOf(stored)).toBeNull();
    expect(threadSnapshotOf(stored)).not.toHaveProperty("worktree");
    expect(threadSummaryOf(stored)).not.toHaveProperty("worktree");
  });
});

describe("the thread's done state", () => {
  const at = (occurredAt: string, planned: OrchestrationEvent): OrchestrationEvent => ({
    ...planned,
    occurredAt,
  });
  const CREATED = "2026-01-02T03:00:00.000Z";
  const MARKED = "2026-01-02T04:00:00.000Z";
  const LATER = "2026-01-02T05:00:00.000Z";

  it("stamps the creation as the first activity, and is not done", () => {
    const doc = foldThread([at(CREATED, created())])!;
    expect(doc.doneAt).toBeNull();
    const summary = threadSummaryOf(doc);
    expect(summary.lastActivityAt).toBe(CREATED);
    expect(summary).not.toHaveProperty("doneAt");
  });

  it("records the mark, and a later turn is newer activity than it", () => {
    const marked = foldThread([
      at(CREATED, created()),
      at(MARKED, event("thread.done.marked", {})),
    ])!;
    expect(threadSummaryOf(marked).doneAt).toBe(MARKED);
    expect(threadSummaryOf(marked).lastActivityAt).toBe(CREATED);

    const resumed = projectThreadEvent(marked, at(LATER, turnRequested()))!;
    const summary = threadSummaryOf(resumed);
    expect(summary.doneAt).toBe(MARKED);
    expect(summary.lastActivityAt! > summary.doneAt!).toBe(true);
  });

  it("counts steers, queued messages and completions as activity, but not a rename", () => {
    const turnId = makeTurnId();
    const base = foldThread([
      at(CREATED, created()),
      at(CREATED, turnRequested(turnId)),
      at(MARKED, event("thread.done.marked", {})),
    ])!;
    const activity: ReadonlyArray<OrchestrationEvent> = [
      event("thread.turn.steered", { turnId, text: "more", attachments: [], mentions: [] }),
      event("thread.message.queued", {
        message: {
          queuedMessageId: makeItemId(),
          text: "next",
          attachments: [],
          mentions: [],
          queuedAt: LATER,
        },
      }),
      event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
    ];
    for (const planned of activity) {
      expect(lastActivityOf(projectThreadEvent(base, at(LATER, planned))!), planned.type).toBe(
        LATER,
      );
    }
    const renamed = projectThreadEvent(base, at(LATER, event("thread.renamed", { title: "New" })))!;
    expect(lastActivityOf(renamed)).toBe(CREATED);
    expect(renamed.updatedAt).toBe(LATER);
  });

  it("drops the mark when cleared, and counts the clear as activity", () => {
    const doc = foldThread([
      at(CREATED, created()),
      at(MARKED, event("thread.done.marked", {})),
      at(LATER, event("thread.done.cleared", {})),
    ])!;
    expect(doc.doneAt).toBeNull();
    expect(threadSummaryOf(doc)).not.toHaveProperty("doneAt");
    expect(threadSummaryOf(doc).lastActivityAt).toBe(LATER);
  });

  it("drops the mark when an archived thread comes back", () => {
    const doc = foldThread([
      at(CREATED, created()),
      at(MARKED, event("thread.done.marked", {})),
      event("thread.archived", {}),
      at(LATER, event("thread.unarchived", {})),
    ])!;
    expect(doc.doneAt).toBeNull();
    expect(lastActivityOf(doc)).toBe(LATER);
  });

  it("folds a document projected before either field existed", () => {
    const {
      doneAt: _doneAt,
      lastActivityAt: _lastActivityAt,
      ...older
    } = foldThread([at(CREATED, created())])!;
    const stored = JSON.parse(JSON.stringify(older)) as ThreadDoc;
    expect(doneAtOf(stored)).toBeNull();
    expect(lastActivityOf(stored)).toBe(stored.updatedAt);
    expect(threadSummaryOf(stored)).not.toHaveProperty("doneAt");
    expect(threadSummaryOf(stored).lastActivityAt).toBe(CREATED);

    const marked = projectThreadEvent(stored, at(MARKED, event("thread.done.marked", {})))!;
    expect(threadSummaryOf(marked).doneAt).toBe(MARKED);
    // The old `updatedAt` stays the last activity once the mark moves it on,
    // so the thread reads as done and a later rename does not undo that.
    expect(threadSummaryOf(marked).lastActivityAt).toBe(CREATED);
    const renamed = projectThreadEvent(
      marked,
      at(LATER, event("thread.renamed", { title: "New" })),
    )!;
    expect(lastActivityOf(renamed)).toBe(CREATED);
  });
});

describe("a forked thread", () => {
  const source = makeThreadId();
  const fork = { threadId: source, title: "Health check", transcript: "User:\nAdd it." };

  it("names its source on the summary and the snapshot, never the transcript", () => {
    const doc = foldThread([
      event("thread.created", {
        threadId,
        projectId,
        title: "Health check (fork)",
        settings: {
          model: "fake/model",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        fork,
      }),
      turnRequested(),
    ])!;
    expect(doc.fork).toEqual(fork);
    const forkedFrom = { threadId: source, title: "Health check" };
    expect(threadSummaryOf(doc).forkedFrom).toEqual(forkedFrom);
    expect(threadSnapshotOf(doc).forkedFrom).toEqual(forkedFrom);
    expect(JSON.stringify(threadSnapshotOf(doc))).not.toContain("Add it.");
  });

  it("leaves a thread that is not a fork, or one projected before forks, without one", () => {
    const doc = foldThread([created()])!;
    expect(doc).not.toHaveProperty("fork");
    const stored = JSON.parse(JSON.stringify(doc)) as ThreadDoc;
    expect(threadSummaryOf(stored)).not.toHaveProperty("forkedFrom");
    expect(threadSnapshotOf(stored)).not.toHaveProperty("forkedFrom");
  });
});
