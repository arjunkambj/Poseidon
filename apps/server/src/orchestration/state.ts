/**
 * The per-aggregate fold: events in, read-model state out.
 *
 * `ThreadDoc` is the stored form of a thread — the wire `ThreadDetailSnapshot`
 * plus the bookkeeping the decider needs (`approvals` is the full open set, of
 * which the wire sees only the first). The same fold drives the decider's view
 * of a stream and the projection written back to `threads.doc_json`, so the
 * decision and the stored read model can never disagree.
 */

import type { DecisionKind, ResolvedDecision } from "@poseidon/contracts/decisions";
import { UNANSWERED_OUTCOME } from "@poseidon/contracts/decisions";
import type { ThreadWorktree } from "@poseidon/contracts/git";
import { latestTurnId } from "@poseidon/contracts/orchestration";
import type {
  Attachment,
  CheckpointRestore,
  CheckpointSummary,
  Mention,
  OrchestrationEvent,
  ProjectSummary,
  QueuedMessage,
  ThreadActivity,
  ThreadDetailSnapshot,
  ThreadSession,
  ThreadSettings,
  ThreadStatus,
  ThreadSummary,
  TurnReference,
  TurnUsage,
  ContextWindowUsage,
} from "@poseidon/contracts/orchestration";
import type { ProjectId, RequestId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import type { ItemKind } from "@poseidon/contracts/enums";
import type { ApprovalRequest, ItemSnapshot, UserQuestion } from "@poseidon/contracts/runtime";
import { approvalSubject, planSubject, questionSubject } from "@poseidon/shared/decisionSubject";

import { activityStamp, doneSummaryFields, lastActivityOf } from "./threadDone";

export type { ApprovalRequest, ItemSnapshot, QueuedMessage, UserQuestion };

// ── Documents ─────────────────────────────────────────────────

export interface PendingUserInput {
  readonly requestId: RequestId;
  readonly questions: ReadonlyArray<UserQuestion>;
}

export interface PendingPlan {
  readonly turnId: TurnId;
  readonly planMarkdown: string;
  readonly planPath?: string;
}

/**
 * The stored thread document: every `ThreadDetailSnapshot` field, plus the
 * internal fields (`approvals`, `userInputs`, `preview`, `deleted`) that the
 * wire never sees.
 */
export interface ThreadDoc {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly settings: ThreadSettings;
  /**
   * The git worktree the thread works in, or `null` for a local thread on the
   * project's root. Set by `thread.created` and never changed. A document
   * projected before the field existed has none, so read it through
   * `worktreeOf`.
   */
  readonly worktree: ThreadWorktree | null;
  readonly snapshotSequence: number;
  readonly items: ReadonlyArray<ItemSnapshot>;
  readonly queue: ReadonlyArray<QueuedMessage>;
  readonly checkpoints: ReadonlyArray<CheckpointSummary>;
  readonly session: ThreadSession | null;
  /**
   * The in-flight turn, with the input it was sent with — resuming a session
   * mid-turn re-sends this, so the input has to live in the document.
   */
  readonly currentTurn: {
    readonly turnId: TurnId;
    readonly input: {
      readonly text: string;
      readonly attachments: ReadonlyArray<Attachment>;
      readonly mentions: ReadonlyArray<Mention>;
      /** Optional, as on the connector's `TurnInput`; absent means none. */
      readonly references?: ReadonlyArray<TurnReference>;
    };
    /**
     * When the turn was requested, for the sidebar's elapsed-time label.
     * Optional: a document folded before the field existed has none.
     */
    readonly startedAt?: string;
  } | null;
  /**
   * True between `thread.turn.interrupted` and the connector's own
   * `thread.turn.completed`. The connector is still winding the turn down
   * (SIGINT, then SIGKILL), and a turn sent inside that window is answered
   * "busy" by the turn-scoped handle — so the decider queues instead.
   */
  readonly interrupting: boolean;
  /**
   * True between `thread.checkpoint.restore.requested` and the reactor's
   * `restored`/`restore.failed`. `git restore` and `git clean -fd` are running
   * over the worktree, so no turn may start and no second restore may begin —
   * in this thread or, via the decider's project-wide guard, in any sibling.
   *
   * Only those two outcomes clear it, deliberately: nothing else in the
   * thread's life knows whether git is still writing to the worktree. A work
   * order whose outcome never reached the log is re-run by the reactor's
   * replay at the next boot, which settles it either way.
   */
  readonly restoring: boolean;
  /**
   * Which checkpoint that restore is for, or `null`. Set and cleared in the
   * same fold branches as `restoring`, so the two cannot disagree; it exists
   * because `restoring` alone is a boolean and `ThreadDetailSnapshot.restoring`
   * carries the checkpoint, which is how a client that reloads mid-restore
   * knows both that one is running and which turn it goes back to.
   */
  readonly restoringCheckpoint: CheckpointSummary | null;
  /**
   * Every restore that went through, oldest first, with the thread's latest
   * turn at the time: a restore records no checkpoint, so this is how the
   * timeline knows the next turn started from the restored one. A document
   * projected before the field existed has none, so read it through
   * `restoresOf`.
   */
  readonly restores: ReadonlyArray<CheckpointRestore>;
  readonly pendingPlan: PendingPlan | null;
  /**
   * Every answered approval, question and plan, oldest first — the record the
   * timeline keeps once a card is gone. A document projected before the field
   * existed has none, so read it through `decisionsOf`.
   */
  readonly decisions: ReadonlyArray<ResolvedDecision>;
  readonly usage: TurnUsage | null;
  readonly context: ContextWindowUsage | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * When the user marked the thread done, and its last activity (see
   * `./threadDone`). A document projected before either existed has neither,
   * so read them through `doneAtOf` and `lastActivityOf`.
   */
  readonly doneAt: string | null;
  readonly lastActivityAt?: string;
  // Internal bookkeeping, not on the wire.
  readonly approvals: ReadonlyArray<ApprovalRequest>;
  readonly userInputs: ReadonlyArray<PendingUserInput>;
  readonly preview: string | undefined;
  readonly deleted: boolean;
}

export interface ProjectDoc {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removed: boolean;
}

const PREVIEW_LENGTH = 140;

const previewOf = (item: ItemSnapshot): string | undefined =>
  (item.kind === "user_message" || item.kind === "assistant_message") && item.text !== undefined
    ? item.text.slice(0, PREVIEW_LENGTH)
    : undefined;

/** The thread's worktree, tolerating a document written before threads had one. */
export const worktreeOf = (doc: ThreadDoc): ThreadWorktree | null =>
  (doc.worktree as ThreadWorktree | null | undefined) ?? null;

/** The restores that went through, tolerating a document written before they were kept. */
const restoresOf = (doc: ThreadDoc): ReadonlyArray<CheckpointRestore> =>
  (doc.restores as ReadonlyArray<CheckpointRestore> | undefined) ?? [];

/** The stored decisions, tolerating a document written before they were kept. */
const decisionsOf = (doc: ThreadDoc): ReadonlyArray<ResolvedDecision> =>
  (doc.decisions as ReadonlyArray<ResolvedDecision> | undefined) ?? [];

/**
 * The outcome to record for a resolve event that finds its request still
 * open. The decider writes every user answer, so the connector reaching an
 * open request first means the runtime released it — the process exited with
 * the card up — and the user chose nothing.
 */
const outcomeOf = (event: OrchestrationEvent, chosen: string): string =>
  event.actor === "connector" ? UNANSWERED_OUTCOME : chosen;

/**
 * Appends one settled decision. `afterItemId` is the thread's last item as
 * the answer lands, which is where the timeline places the record.
 *
 * Callers record only an answer to something still open: the connector
 * echoes every answer the decider already wrote (`request.resolved`,
 * `user-input.resolved`), and the echo must not write a second line.
 */
const withDecision = (
  doc: ThreadDoc,
  event: OrchestrationEvent,
  decision: Pick<ResolvedDecision, "kind" | "id" | "outcome" | "subject" | "pattern">,
): ReadonlyArray<ResolvedDecision> => {
  const afterItemId = doc.items.at(-1)?.itemId;
  return [
    ...decisionsOf(doc),
    {
      kind: decision.kind,
      id: decision.id,
      outcome: decision.outcome,
      ...(decision.subject === undefined ? {} : { subject: decision.subject }),
      ...(decision.pattern === undefined ? {} : { pattern: decision.pattern }),
      resolvedAt: event.occurredAt,
      ...(afterItemId === undefined ? {} : { afterItemId }),
    },
  ];
};

const waitingOr = (doc: ThreadDoc, fallback: ThreadStatus): ThreadStatus =>
  doc.approvals.length > 0 || doc.userInputs.length > 0 || doc.pendingPlan !== null
    ? "waiting"
    : fallback;

/**
 * The thread's chosen connector after a settings patch: the patch's when it
 * names one, the one already stored otherwise. Spread rather than assigned so
 * a thread that never chose one keeps no `connectorInstanceId` key at all.
 */
const connectorOf = (
  patched: unknown,
  settings: ThreadSettings,
): Pick<ThreadSettings, "connectorInstanceId"> => {
  const chosen = (patched as ThreadSettings["connectorInstanceId"]) ?? settings.connectorInstanceId;
  return chosen === undefined ? {} : { connectorInstanceId: chosen };
};

// ── Thread fold ───────────────────────────────────────────────

const applyThreadEvent = (doc: ThreadDoc | null, event: OrchestrationEvent): ThreadDoc | null => {
  if (event.streamKind !== "thread") {
    return doc;
  }
  const type = event.type;
  const payload = event.payload as Record<string, unknown>;

  if (type === "thread.created") {
    return {
      threadId: payload.threadId as ThreadId,
      projectId: payload.projectId as ProjectId,
      title: payload.title as string,
      status: "idle",
      settings: payload.settings as ThreadSettings,
      worktree: (payload.worktree as ThreadWorktree | undefined) ?? null,
      snapshotSequence: event.sequence,
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
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      doneAt: null,
      lastActivityAt: event.occurredAt,
      approvals: [],
      userInputs: [],
      preview: undefined,
      deleted: false,
    };
  }

  if (doc === null) {
    return null;
  }
  // `lastActivityAt` is pinned before `updatedAt` moves on, so a document
  // projected before it existed keeps its old `updatedAt` as its last activity.
  const next = {
    ...doc,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
    lastActivityAt: lastActivityOf(doc),
    ...activityStamp(event),
  };

  switch (type) {
    case "thread.renamed":
      return { ...next, title: payload.title as string };
    case "thread.archived":
      return { ...next, status: "archived" };
    case "thread.unarchived":
      // Archiving closes the session, so an approval or question still open
      // is a dead process asking — the same reasoning as `session.lost`, and
      // `currentTurn` goes for the same reason. The close may still be
      // settling that turn: its late `turn.completed` names the old turn, and
      // the `turn.completed` fold below ignores it once a newer one started.
      // The session itself stays: the next turn resumes the conversation
      // through its `sessionRef`. The queue and a pending plan stay too; the
      // plan waits for its answer and the queue drains after the next turn
      // completes.
      return {
        ...next,
        approvals: [],
        userInputs: [],
        currentTurn: null,
        interrupting: false,
        doneAt: null,
        status: waitingOr({ ...doc, approvals: [], userInputs: [] }, "idle"),
      };
    case "thread.deleted":
      return { ...next, deleted: true };
    case "thread.done.marked":
      return { ...next, doneAt: event.occurredAt };
    case "thread.done.cleared":
      return { ...next, doneAt: null };
    case "thread.session.bound":
      // The capabilities ride along when the connector announced them — the
      // decider reads `steering` here. A session bound before they were
      // recorded has none: not known to steer, so a steer is queued.
      return {
        ...next,
        session: {
          connectorInstanceId: payload.connectorInstanceId as ThreadSession["connectorInstanceId"],
          connectorKind: payload.connectorKind as string,
          sessionRef: payload.sessionRef,
          ...(payload.capabilities === undefined
            ? {}
            : { capabilities: payload.capabilities as ThreadSession["capabilities"] }),
        },
      };
    case "thread.session.lost":
      // Dropping `currentTurn` matters as much as dropping the session: the
      // turn it names can never complete, because the process that would have
      // completed it is gone. Leaving it set makes the decider reject every
      // later `thread.turn.start` ("a turn is already running") and leaves the
      // queue with no drain — the thread would be wedged for good.
      //
      // The open approvals and questions go with it, and for the same reason:
      // they are a dead process asking, so answering one can never reach
      // anybody. The card would sit in the timeline and `awaitingInput` would
      // stay true, which is the same wedge one field along.
      //
      // The queue deliberately survives. Draining it here would send the
      // messages into the loss that just happened — and re-entering
      // `sessions.ensure` when the binary is gone loops. They stay where the
      // user put them, visible in the strip, and the drain the *next* turn's
      // completion runs picks them up.
      return {
        ...next,
        session: null,
        currentTurn: null,
        interrupting: false,
        approvals: [],
        userInputs: [],
        status: "error",
      };
    case "thread.turn.requested":
      return {
        ...next,
        currentTurn: {
          turnId: payload.turnId as TurnId,
          input: {
            text: payload.text as string,
            attachments: (payload.attachments ?? []) as ReadonlyArray<Attachment>,
            mentions: (payload.mentions ?? []) as ReadonlyArray<Mention>,
            references: (payload.references ?? []) as ReadonlyArray<TurnReference>,
          },
          startedAt: event.occurredAt,
        },
        status: "running",
      };
    case "thread.turn.started":
      return { ...next, status: "running" };
    case "thread.turn.completed":
      // A completion for a turn other than the one in flight is a late
      // settlement: archiving a thread mid-turn closes its session, the close
      // settles that turn when it gets there, and by then the thread may be
      // unarchived with a newer turn running. Ending the newer turn on the
      // old one's word would let the next send start a turn the connector
      // answers "busy" to, which the reactor turns into a fatal thread error.
      if (doc.currentTurn !== null && doc.currentTurn.turnId !== payload.turnId) {
        return next;
      }
      // An archived thread stays archived: the settlement of a turn its
      // connector was stopped mid-answer must not put it back in the sidebar.
      return {
        ...next,
        currentTurn: null,
        interrupting: false,
        status: doc.status === "archived" ? "archived" : waitingOr(doc, "idle"),
      };
    case "thread.turn.steered":
      // The message joined the turn already running, which stays as it is:
      // no new turn, and the user's row arrives as its own `item.upserted`.
      return next;
    case "thread.turn.interrupted":
      // The interrupt is a request, not the end of the turn: the connector
      // still has to stop, and it settles the turn with its own
      // `turn.completed`. Clearing `currentTurn` here would let the next
      // message start a turn the connector answers "busy" to, which the
      // reactor turns into a fatal thread error.
      return { ...next, interrupting: true, status: "running" };
    case "thread.message.queued":
      return {
        ...next,
        queue: [...doc.queue, payload.message as QueuedMessage],
      };
    case "thread.message.dequeued":
      return {
        ...next,
        queue: doc.queue.filter(
          (message) => message.queuedMessageId !== (payload.queuedMessageId as string),
        ),
      };
    case "thread.queue.reordered": {
      // The event carries the order, not the move: ids the queue no longer
      // holds are skipped, and a message the order does not mention keeps its
      // place behind the ones it does.
      const order = payload.order as ReadonlyArray<string>;
      const rank = new Map(order.map((id, index) => [id, index]));
      return {
        ...next,
        queue: [...doc.queue].sort(
          (a, b) =>
            (rank.get(a.queuedMessageId) ?? order.length) -
            (rank.get(b.queuedMessageId) ?? order.length),
        ),
      };
    }
    case "thread.item.upserted": {
      // The turn id lives on the event; keeping it on the stored row is what
      // lets a client that only ever sees the snapshot group the timeline by
      // turn. A row the connector already stamped wins over the envelope.
      const upserted = payload.item as ItemSnapshot;
      const index = doc.items.findIndex((existing) => existing.itemId === upserted.itemId);
      // The row the turn already grouped keeps its turn: an envelope written
      // after the turn's scope closed carries no `turnId`, and taking that as
      // "no turn" would ungroup a row a later update merely touched.
      const turnId =
        upserted.turnId ?? (payload.turnId as TurnId | undefined) ?? doc.items[index]?.turnId;
      const item: ItemSnapshot = turnId === undefined ? upserted : { ...upserted, turnId };
      const items =
        index === -1
          ? [...doc.items, item]
          : doc.items.map((existing, i) => (i === index ? item : existing));
      const preview = previewOf(item) ?? doc.preview;
      return { ...next, items, preview };
    }
    case "thread.approval.opened":
      return {
        ...next,
        approvals: [...doc.approvals, payload.request as ApprovalRequest],
        status: "waiting",
      };
    case "thread.approval.resolved": {
      // Read the request before it is filtered out: the record names what
      // was approved, and nothing else in the document still knows.
      const requestId = payload.requestId as RequestId;
      const request = doc.approvals.find((open) => open.requestId === requestId);
      const approvals = doc.approvals.filter((open) => open.requestId !== requestId);
      return {
        ...next,
        approvals,
        decisions:
          request === undefined
            ? decisionsOf(doc)
            : withDecision(doc, event, {
                kind: "approval",
                id: requestId,
                outcome: outcomeOf(event, payload.decision as string),
                subject: approvalSubject(request),
                pattern: payload.pattern as string | undefined,
              }),
        status: doc.currentTurn === null ? waitingOr({ ...doc, approvals }, "idle") : "running",
      };
    }
    case "thread.userInput.requested":
      return {
        ...next,
        userInputs: [
          ...doc.userInputs,
          {
            requestId: payload.requestId as RequestId,
            questions: payload.questions as ReadonlyArray<UserQuestion>,
          },
        ],
        status: "waiting",
      };
    case "thread.userInput.resolved": {
      const requestId = payload.requestId as RequestId;
      const asked = doc.userInputs.find((pending) => pending.requestId === requestId);
      const userInputs = doc.userInputs.filter((pending) => pending.requestId !== requestId);
      return {
        ...next,
        userInputs,
        decisions:
          asked === undefined
            ? decisionsOf(doc)
            : withDecision(doc, event, {
                kind: "question",
                id: requestId,
                outcome: outcomeOf(event, "answered"),
                subject: questionSubject(asked.questions),
              }),
        status: doc.currentTurn === null ? waitingOr({ ...doc, userInputs }, "idle") : "running",
      };
    }
    case "thread.plan.proposed":
      return {
        ...next,
        pendingPlan: {
          turnId: payload.turnId as TurnId,
          planMarkdown: payload.planMarkdown as string,
          ...(payload.planPath === undefined ? {} : { planPath: payload.planPath as string }),
        },
        status: "waiting",
      };
    case "thread.plan.responded": {
      // `waitingOr` reads the plan that was just answered, so it has to see
      // the document with that plan already gone — as the two resolve cases
      // above pass their filtered arrays. Passing `doc` left a thread with no
      // turn running parked on "waiting" over its own answered plan.
      const plan = doc.pendingPlan;
      return {
        ...next,
        pendingPlan: null,
        decisions:
          plan !== null && plan.turnId === payload.turnId
            ? withDecision(doc, event, {
                kind: "plan",
                id: plan.turnId,
                outcome: payload.action as string,
                subject: planSubject((payload.planPath as string | undefined) ?? plan.planPath),
              })
            : decisionsOf(doc),
        status:
          doc.currentTurn === null ? waitingOr({ ...doc, pendingPlan: null }, "idle") : "running",
      };
    }
    case "thread.settings.updated":
      return {
        ...next,
        settings: {
          model: (payload.model as string | undefined) ?? doc.settings.model,
          effort:
            payload.effort === undefined
              ? doc.settings.effort
              : (payload.effort as ThreadSettings["effort"]),
          runtimeMode:
            (payload.runtimeMode as ThreadSettings["runtimeMode"]) ?? doc.settings.runtimeMode,
          interactionMode:
            (payload.interactionMode as ThreadSettings["interactionMode"]) ??
            doc.settings.interactionMode,
          ...connectorOf(payload.connectorInstanceId, doc.settings),
        },
      };
    case "thread.usage.updated":
      return { ...next, usage: payload.usage as TurnUsage };
    case "thread.context.updated":
      return { ...next, context: payload as unknown as ContextWindowUsage };
    case "thread.checkpoint.created":
      return {
        ...next,
        checkpoints: [...doc.checkpoints, payload.checkpoint as CheckpointSummary],
      };
    case "thread.checkpoint.restore.requested":
      return {
        ...next,
        restoring: true,
        restoringCheckpoint: payload.checkpoint as CheckpointSummary,
      };
    case "thread.checkpoint.restored":
      // The worktree moved back. The document has nothing to rewind — the
      // checkpoint refs still exist — but the next turn starts from the
      // restored checkpoint, not the latest turn's, and nothing else says so.
      return {
        ...next,
        restoring: false,
        restoringCheckpoint: null,
        restores: [
          ...restoresOf(doc),
          {
            checkpoint: payload.checkpoint as CheckpointSummary,
            afterTurnId: latestTurnId(doc.items),
          },
        ],
      };
    case "thread.checkpoint.restore.failed":
      // The worktree did not move; the event only settles the in-flight restore.
      return { ...next, restoring: false, restoringCheckpoint: null };
    case "thread.error":
      return payload.fatal === true
        ? { ...next, status: "error", currentTurn: null, interrupting: false }
        : next;
    default:
      return next;
  }
};

/** Folds one thread stream into its document. */
export const foldThread = (events: ReadonlyArray<OrchestrationEvent>): ThreadDoc | null => {
  let doc: ThreadDoc | null = null;
  for (const event of events) {
    doc = applyThreadEvent(doc, event);
  }
  return doc;
};

/** Applies one event to an already-folded document — the projector's step. */
export const projectThreadEvent = applyThreadEvent;

// ── Project fold ──────────────────────────────────────────────

const applyProjectEvent = (
  doc: ProjectDoc | null,
  event: OrchestrationEvent,
): ProjectDoc | null => {
  if (event.streamKind !== "project") {
    return doc;
  }
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "project.created") {
    return {
      projectId: payload.projectId as ProjectId,
      name: payload.name as string,
      workspaceRoot: payload.workspaceRoot as string,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      removed: false,
    };
  }
  if (doc === null) {
    return null;
  }
  if (event.type === "project.removed") {
    return { ...doc, removed: true, updatedAt: event.occurredAt };
  }
  return doc;
};

export const foldProject = (events: ReadonlyArray<OrchestrationEvent>): ProjectDoc | null => {
  let doc: ProjectDoc | null = null;
  for (const event of events) {
    doc = applyProjectEvent(doc, event);
  }
  return doc;
};

/** The projector's step for the project stream. */
export const projectProjectEvent = applyProjectEvent;

// ── Wire shapes ───────────────────────────────────────────────

/** The wire's optional `worktree`: present only for a thread that has one. */
const worktreeField = (doc: ThreadDoc): { readonly worktree?: ThreadWorktree } => {
  const worktree = worktreeOf(doc);
  return worktree === null ? {} : { worktree };
};

/** The `ThreadDetailSnapshot` a subscription's `snapshot` item carries. */
export const threadSnapshotOf = (doc: ThreadDoc): ThreadDetailSnapshot => ({
  threadId: doc.threadId,
  projectId: doc.projectId,
  title: doc.title,
  status: doc.status,
  settings: doc.settings,
  ...worktreeField(doc),
  snapshotSequence: doc.snapshotSequence,
  items: doc.items,
  queue: doc.queue,
  checkpoints: doc.checkpoints,
  // On the wire so a client that reloads mid-restore still knows one is
  // running; folding the three restore events was the client's only source
  // before, and a fresh snapshot forgot them.
  restoring: doc.restoringCheckpoint,
  restores: restoresOf(doc),
  session: doc.session,
  currentTurnId: doc.currentTurn?.turnId ?? null,
  pendingApproval: doc.approvals[0] ?? null,
  pendingUserInput: doc.userInputs[0] ?? null,
  pendingPlan: doc.pendingPlan,
  decisions: decisionsOf(doc),
  usage: doc.usage,
  context: doc.context,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/**
 * The card a thread is waiting on, most urgent first: an approval holds a
 * tool call mid-turn, a question holds the model, a plan waits for the
 * user's next move.
 */
const awaitingOf = (doc: ThreadDoc): DecisionKind | undefined =>
  doc.approvals.length > 0
    ? "approval"
    : doc.userInputs.length > 0
      ? "question"
      : doc.pendingPlan !== null
        ? "plan"
        : undefined;

/** The rows that are the agent acting rather than the model writing. */
const WORKING_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "command_execution",
  "file_change",
  "tool_call",
  "mcp_tool_call",
  "web_search",
  "task",
  "todo",
  "skill",
]);

/**
 * What a running turn is doing: `working` while one of its tool rows is
 * still in progress, `thinking` otherwise. Nothing for a thread that is not
 * running.
 */
const activityOf = (doc: ThreadDoc): ThreadActivity | undefined => {
  if (doc.status !== "running") {
    return undefined;
  }
  const turnId = doc.currentTurn?.turnId;
  // The turn's rows are the newest ones, so walk back only as far as they go:
  // this runs for every event, and a long thread has thousands of rows.
  for (let index = doc.items.length - 1; index >= 0; index--) {
    const item = doc.items[index];
    if (item === undefined) {
      continue;
    }
    if (turnId !== undefined && item.turnId !== undefined && item.turnId !== turnId) {
      break;
    }
    if (item.status === "in_progress" && WORKING_KINDS.has(item.kind)) {
      return "working";
    }
  }
  return "thinking";
};

/** The `ThreadSummary` the sidebar lists. */
export const threadSummaryOf = (doc: ThreadDoc): ThreadSummary => {
  const awaiting = awaitingOf(doc);
  const activity = activityOf(doc);
  return {
    threadId: doc.threadId,
    projectId: doc.projectId,
    title: doc.title,
    status: doc.status,
    settings: doc.settings,
    ...(doc.preview === undefined ? {} : { preview: doc.preview }),
    awaitingInput: awaiting !== undefined,
    ...(awaiting === undefined ? {} : { awaiting }),
    ...(activity === undefined ? {} : { activity }),
    ...(doc.status === "running" && doc.currentTurn?.startedAt !== undefined
      ? { runningSince: doc.currentTurn.startedAt }
      : {}),
    ...worktreeField(doc),
    ...doneSummaryFields(doc),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

export const projectSummaryOf = (doc: ProjectDoc, threadCount: number): ProjectSummary => ({
  projectId: doc.projectId,
  name: doc.name,
  workspaceRoot: doc.workspaceRoot,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  threadCount,
});
