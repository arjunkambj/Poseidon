/**
 * The client-side fold: applies `ThreadStreamItem`s to a `ThreadDetailSnapshot`
 * and `ThreadListStreamItem`s to a summary array. This is a projection of the
 * server's own projection — it merges deltas, it never decides anything.
 */

import type { ResolvedDecision } from "@poseidon/contracts/decisions";
import { UNANSWERED_OUTCOME } from "@poseidon/contracts/decisions";
import { latestTurnId } from "@poseidon/contracts/orchestration";
import type {
  CheckpointSummary,
  OrchestrationEvent,
  ThreadDetailSnapshot,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "@poseidon/contracts/orchestration";
import { approvalSubject, planSubject, questionSubject } from "@poseidon/shared/decisionSubject";

/** A restore git refused, kept until the next restore is ordered. */
export interface ThreadRestoreFailure {
  readonly checkpointId: string;
  readonly message: string;
}

/**
 * The snapshot plus the little the client has to track for itself.
 *
 * A checkpoint restore is a durable work order: the server accepts it
 * (`thread.checkpoint.restore.requested`), the reactor runs git, and only then
 * does `thread.checkpoint.restored` or `thread.checkpoint.restore.failed`
 * arrive. `restoring` is on the wire — `ThreadDetailSnapshot.restoring`, filled
 * from the server's own document — and the fold below keeps it current between
 * snapshots, so the two agree and a client that reloads mid-restore still knows
 * one is running.
 *
 * `restoreFailure` is the client's alone. The reason git gave lives in the
 * `restore.failed` event and nowhere else, so it lasts exactly as long as the
 * subscription that saw it: a failure that lands while the window is closed is
 * in the timeline as an error, but the pane's own line does not come back.
 *
 * Both fields are *optional* so a plain `ThreadDetailSnapshot` — the dev
 * fixtures, a component prop typed against the contract — still satisfies this
 * type. That keeps the view from having to be plumbed through every component
 * between the atom and the pane: the object the atom emits carries the fields,
 * and only the reader that wants them has to say so.
 */
export interface ThreadDetailView extends ThreadDetailSnapshot {
  /** Why the last restore failed, until another one is ordered. */
  readonly restoreFailure?: ThreadRestoreFailure | null;
}

/**
 * `waiting` whenever a card is open, the given status otherwise — the client's
 * copy of `waitingOr` in apps/server/src/orchestration/state.ts. The server
 * holds arrays of open approvals and questions where the snapshot carries only
 * the head of each, but "is anything open" is the same question either way.
 */
const waitingOr = (doc: ThreadDetailView, fallback: ThreadDetailView["status"]) =>
  doc.pendingApproval !== null || doc.pendingUserInput !== null || doc.pendingPlan !== null
    ? "waiting"
    : fallback;

/**
 * Where one answered card leaves the thread: back to the turn it interrupted
 * if one is still running, and otherwise to whatever else is still open. The
 * caller passes the document with its own card already cleared, so a thread
 * with nothing left open lands on `idle` rather than staying `waiting` on its
 * own answered question.
 */
const settledStatus = (doc: ThreadDetailView) =>
  doc.currentTurnId === null ? waitingOr(doc, "idle") : "running";

/**
 * Whether an answer the fold cannot see open was already recorded. The
 * connector echoes every answer the decider wrote, and the server records
 * only the first; the client, which sees only the head of each list, tells
 * the echo apart by the line it already holds.
 */
const recorded = (doc: ThreadDetailView, kind: ResolvedDecision["kind"], id: unknown): boolean =>
  (doc.decisions ?? []).some((decision) => decision.kind === kind && decision.id === id);

/**
 * The outcome to record, matching the server's fold: a resolve the connector
 * sends for a request not already recorded is the runtime releasing it as the
 * process exits, not a choice the user made.
 */
const outcomeOf = (event: OrchestrationEvent, chosen: string): string =>
  event.actor === "connector" ? UNANSWERED_OUTCOME : chosen;

/**
 * The server's decision record, appended between snapshots. The snapshot
 * holds only the head of each open list, so an answer to anything behind it
 * is recorded without a subject — the server's next snapshot, which knew the
 * whole list, fills it in.
 */
const withDecision = (
  doc: ThreadDetailView,
  event: OrchestrationEvent,
  decision: Pick<ResolvedDecision, "kind" | "id" | "outcome" | "subject" | "pattern">,
): ReadonlyArray<ResolvedDecision> => {
  const afterItemId = doc.items.at(-1)?.itemId;
  return [
    ...(doc.decisions ?? []),
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

/**
 * Merges one orchestration event into the snapshot. Payload fields map
 * straight onto the document — the server's fold already validated them.
 */
export const applyThreadEvent = (
  doc: ThreadDetailView,
  event: OrchestrationEvent,
): ThreadDetailView => {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "thread.renamed":
      return { ...doc, title: payload.title as string, updatedAt: event.occurredAt };
    case "thread.archived":
      return { ...doc, status: "archived", updatedAt: event.occurredAt };
    case "thread.unarchived":
      // Mirrors the server's fold in apps/server/src/orchestration/state.ts.
      // Archiving closed the session, so an approval or question still open
      // was asked by a process that is gone — both cards come down, and the
      // turn with them. The session, the queue and a pending plan stay: the
      // next turn resumes through the session, and a plan still waits for
      // its answer.
      return {
        ...doc,
        pendingApproval: null,
        pendingUserInput: null,
        currentTurnId: null,
        status: waitingOr({ ...doc, pendingApproval: null, pendingUserInput: null }, "idle"),
        updatedAt: event.occurredAt,
      };
    case "thread.done.marked":
    case "thread.done.cleared":
      // The Active/Done split lives on the sidebar's `ThreadSummary`; the
      // open thread's view has nothing to change but the time.
      return { ...doc, updatedAt: event.occurredAt };
    case "thread.deleted":
      // Not the same as archived: the thread is gone from the server, so an
      // open timeline has to say so (and the route can redirect) instead of
      // sitting there looking merely filed away.
      return { ...doc, status: "deleted", currentTurnId: null, updatedAt: event.occurredAt };
    case "thread.session.bound":
      return {
        ...doc,
        // The capabilities come along when the connector announced them: the
        // composer reads `steering` off the session — the decider's own
        // source — to know whether a message sent mid-turn goes into the
        // running turn or onto the queue.
        session: {
          connectorInstanceId: payload.connectorInstanceId,
          connectorKind: payload.connectorKind,
          sessionRef: payload.sessionRef,
          ...(payload.capabilities === undefined ? {} : { capabilities: payload.capabilities }),
        } as ThreadDetailSnapshot["session"],
        updatedAt: event.occurredAt,
      };
    case "thread.session.lost":
      // The server's fold settles the thread here — no session, no turn, and
      // none of the open questions the dead process asked, because answering
      // one can never reach anybody. This has to do the same or a connected
      // client keeps an unanswerable approval card up until it resnapshots,
      // which is the very wedge the server-side fold was changed to clear.
      // The queue deliberately survives on both sides.
      return {
        ...doc,
        session: null,
        currentTurnId: null,
        pendingApproval: null,
        pendingUserInput: null,
        status: "error",
        updatedAt: event.occurredAt,
      };
    case "thread.turn.requested":
      // The turn is in flight from the moment it is requested, as on the
      // server, whose fold sets its current turn here and whose snapshot
      // already reports it. Waiting for `turn.started` left a window — the
      // connector's whole startup — where a late settlement of an older turn
      // an archive closed looked like the end of this one.
      return {
        ...doc,
        status: "running",
        currentTurnId: payload.turnId as ThreadDetailSnapshot["currentTurnId"],
        updatedAt: event.occurredAt,
      };
    case "thread.turn.started":
      return {
        ...doc,
        status: "running",
        currentTurnId: payload.turnId as ThreadDetailSnapshot["currentTurnId"],
        updatedAt: event.occurredAt,
      };
    case "thread.turn.steered":
      // The message joined the turn already running, as on the server: no new
      // turn, and the user's row arrives through its own `item.upserted`.
      return { ...doc, updatedAt: event.occurredAt };
    case "thread.turn.interrupted":
      // An interrupt is a request, not the end of the turn: the connector
      // still has to stop and settles the turn with its own `turn.completed`.
      // The server's fold keeps `currentTurnId` here for the same reason, and
      // the two folds have to agree or a resnapshot contradicts the live view.
      return { ...doc, updatedAt: event.occurredAt };
    case "thread.turn.completed":
      // `pendingPlan` survives the turn's end: the server proposes plans late
      // in the turn and the user answers after it finishes — the plan card
      // must stay up until `thread.plan.responded` clears it. Which is exactly
      // why the status has to be `waiting` here whenever a card is open: the
      // connector emits the proposal immediately before it ends the turn, so
      // `idle` meant every plan-mode turn parked the header pill on "Idle"
      // beside a sidebar row — fed by the server's summary — marked waiting.
      //
      // An archived thread stays archived, as on the server: a turn its
      // connector was stopped mid-answer must not file it back into the list.
      //
      // The queue is the one place the client is deliberately ahead: the
      // server says `idle` and its reactor's drain turns the thread `running`
      // a beat later, and following it would blink the pill on every queued
      // message.
      //
      // A completion for a turn other than the one in flight is the late
      // settlement of a turn an archive closed, landing after an unarchive
      // let a newer turn be requested. The server's fold ignores it; so does
      // this.
      if (doc.currentTurnId !== null && doc.currentTurnId !== payload.turnId) {
        return { ...doc, updatedAt: event.occurredAt };
      }
      return {
        ...doc,
        status:
          doc.status === "archived"
            ? "archived"
            : waitingOr(doc, doc.queue.length > 0 ? "running" : "idle"),
        currentTurnId: null,
        updatedAt: event.occurredAt,
      };
    case "thread.message.queued":
      return {
        ...doc,
        queue: [...doc.queue, payload.message as never],
        updatedAt: event.occurredAt,
      };
    case "thread.message.dequeued":
      return {
        ...doc,
        queue: doc.queue.filter((message) => message.queuedMessageId !== payload.queuedMessageId),
        updatedAt: event.occurredAt,
      };
    case "thread.queue.reordered": {
      // The same fold the server projection does: the event carries the whole
      // order, so an id the queue no longer holds simply does not place one.
      const order = payload.order as ReadonlyArray<string>;
      const rank = new Map(order.map((id, index) => [id, index]));
      return {
        ...doc,
        queue: [...doc.queue].sort(
          (a, b) =>
            (rank.get(a.queuedMessageId) ?? order.length) -
            (rank.get(b.queuedMessageId) ?? order.length),
        ),
        updatedAt: event.occurredAt,
      };
    }
    case "thread.item.upserted": {
      const item = payload.item as ThreadDetailSnapshot["items"][number];
      const index = doc.items.findIndex((existing) => existing.itemId === item.itemId);
      return {
        ...doc,
        items:
          index === -1
            ? [...doc.items, item]
            : doc.items.map((existing, i) => (i === index ? item : existing)),
        updatedAt: event.occurredAt,
      };
    }
    // Each of the three "a card is open" events puts the thread in `waiting`,
    // and each answer hands it back to the turn that is still running or, when
    // none is, to whatever else is still open. Same rules as the server's fold.
    case "thread.approval.opened":
      return {
        ...doc,
        pendingApproval: payload.request as ThreadDetailSnapshot["pendingApproval"],
        status: "waiting",
        updatedAt: event.occurredAt,
      };
    // Every first answer is recorded, as the server records it, whether or
    // not it closes the card this snapshot shows.
    case "thread.approval.resolved": {
      const open = doc.pendingApproval?.requestId === payload.requestId;
      if (!open && recorded(doc, "approval", payload.requestId)) {
        return doc;
      }
      const decisions = withDecision(doc, event, {
        kind: "approval",
        id: payload.requestId as string,
        outcome: outcomeOf(event, payload.decision as string),
        subject:
          open && doc.pendingApproval !== null ? approvalSubject(doc.pendingApproval) : undefined,
        pattern: payload.pattern as string | undefined,
      });
      return open
        ? {
            ...doc,
            pendingApproval: null,
            decisions,
            status: settledStatus({ ...doc, pendingApproval: null }),
            updatedAt: event.occurredAt,
          }
        : { ...doc, decisions };
    }
    case "thread.userInput.requested":
      return {
        ...doc,
        pendingUserInput: {
          requestId: payload.requestId,
          questions: payload.questions,
        } as ThreadDetailSnapshot["pendingUserInput"],
        status: "waiting",
        updatedAt: event.occurredAt,
      };
    case "thread.userInput.resolved": {
      const open = doc.pendingUserInput?.requestId === payload.requestId;
      if (!open && recorded(doc, "question", payload.requestId)) {
        return doc;
      }
      const decisions = withDecision(doc, event, {
        kind: "question",
        id: payload.requestId as string,
        outcome: outcomeOf(event, "answered"),
        subject:
          open && doc.pendingUserInput !== null
            ? questionSubject(doc.pendingUserInput.questions)
            : undefined,
      });
      return open
        ? {
            ...doc,
            pendingUserInput: null,
            decisions,
            status: settledStatus({ ...doc, pendingUserInput: null }),
            updatedAt: event.occurredAt,
          }
        : { ...doc, decisions };
    }
    case "thread.plan.proposed":
      return {
        ...doc,
        pendingPlan: {
          turnId: payload.turnId,
          planMarkdown: payload.planMarkdown,
          planPath: payload.planPath,
        } as ThreadDetailSnapshot["pendingPlan"],
        status: "waiting",
        updatedAt: event.occurredAt,
      };
    case "thread.plan.responded": {
      // A thread has one plan open at most, and the snapshot carries it, so
      // this answer is recorded exactly when the server records it.
      const plan = doc.pendingPlan;
      return plan !== null && plan.turnId === payload.turnId
        ? {
            ...doc,
            pendingPlan: null,
            decisions: withDecision(doc, event, {
              kind: "plan",
              id: plan.turnId,
              outcome: payload.action as string,
              subject: planSubject((payload.planPath as string | undefined) ?? plan.planPath),
            }),
            status: settledStatus({ ...doc, pendingPlan: null }),
            updatedAt: event.occurredAt,
          }
        : doc;
    }
    case "thread.settings.updated":
      return {
        ...doc,
        settings: { ...doc.settings, ...payload } as ThreadDetailSnapshot["settings"],
        updatedAt: event.occurredAt,
      };
    case "thread.usage.updated":
      return { ...doc, usage: payload.usage as never, updatedAt: event.occurredAt };
    case "thread.context.updated":
      return { ...doc, context: payload as never, updatedAt: event.occurredAt };
    case "thread.checkpoint.created":
      return {
        ...doc,
        checkpoints: [
          ...doc.checkpoints,
          payload.checkpoint as ThreadDetailSnapshot["checkpoints"][number],
        ],
        updatedAt: event.occurredAt,
      };
    case "thread.checkpoint.restore.requested":
      // The order is accepted and durable; the git work has not run yet. A
      // previous failure is cleared here rather than when the new one lands,
      // so the pane stops showing a stale error the moment the user retries.
      return {
        ...doc,
        restoring: payload.checkpoint as CheckpointSummary,
        restoreFailure: null,
        updatedAt: event.occurredAt,
      };
    case "thread.checkpoint.restored":
      // The server's fold records the restore after the latest turn the same
      // way, so the next turn's "before" is the restored checkpoint here too.
      return {
        ...doc,
        restoring: null,
        restoreFailure: null,
        restores: [
          ...(doc.restores ?? []),
          {
            checkpoint: payload.checkpoint as CheckpointSummary,
            afterTurnId: latestTurnId(doc.items),
          },
        ],
        updatedAt: event.occurredAt,
      };
    case "thread.checkpoint.restore.failed":
      // git refused — a dirty worktree, a missing ref, a dirty submodule. The
      // message is the only thing that says which, so it outlives the event.
      return {
        ...doc,
        restoring: null,
        restoreFailure: {
          checkpointId: payload.checkpointId as string,
          message: payload.message as string,
        },
        updatedAt: event.occurredAt,
      };
    case "thread.error":
      // `error`, not `idle`: apps/server/src/orchestration/state.ts settles a
      // fatal error that way, and a fatal error outside a turn has no
      // `turn.completed` behind it to converge the two folds. Saying `idle`
      // here left the header pill disagreeing with the sidebar row — which is
      // fed by the server's own `ThreadSummary` — until a resnapshot flipped
      // it with nothing having happened in between.
      return payload.fatal === true
        ? { ...doc, status: "error", currentTurnId: null, updatedAt: event.occurredAt }
        : doc;
    default:
      return doc;
  }
};

/**
 * The live thread view. `synchronized` isn't an update — the atom uses it to
 * flip its own "caught up" flag.
 */
export const applyThreadStreamItem = (
  doc: ThreadDetailView | null,
  item: ThreadStreamItem,
): ThreadDetailView | null => {
  switch (item.kind) {
    case "snapshot":
      // A snapshot replaces the doc wholesale, restore flags included. Every
      // path that produces one has already thrown the old doc away: the atom
      // clears it on `resnapshot-required`, and the subscribe loop clears it
      // whenever it asks without `afterSequence` — which is the only ask the
      // server answers with a snapshot at all. See the type's docblock for
      // what that costs.
      return item.snapshot;
    case "event":
      return doc === null || item.event.sequence <= doc.snapshotSequence
        ? doc
        : { ...applyThreadEvent(doc, item.event), snapshotSequence: item.event.sequence };
    default:
      return doc;
  }
};

/**
 * Most recent activity first, as the server's snapshot orders it. A new
 * thread is the most recent thing there is, so it lands on top too. ISO
 * timestamps compare correctly as strings.
 */
const byRecentActivity = (a: ThreadSummary, b: ThreadSummary): number =>
  b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt);

/**
 * The sidebar list fold — keyed by threadId, `snapshot` replaces wholesale.
 * Every result is re-sorted: an upsert moves `updatedAt`, and a list that
 * kept its old positions would disagree with the next snapshot.
 */
export const applyThreadListItem = (
  threads: ReadonlyArray<ThreadSummary>,
  item: ThreadListStreamItem,
): ReadonlyArray<ThreadSummary> => {
  switch (item.kind) {
    case "snapshot":
      return [...item.threads].sort(byRecentActivity);
    case "upserted": {
      const rest = threads.filter((t) => t.threadId !== item.thread.threadId);
      return [...rest, item.thread].sort(byRecentActivity);
    }
    case "removed":
      return threads.filter((t) => t.threadId !== item.threadId);
    case "resnapshot-required":
      // The server can no longer replay from where this client stands, so
      // everything held is suspect — drop it and wait for the fresh snapshot
      // rather than showing a list that quietly stopped updating.
      return [];
    default:
      return threads;
  }
};
