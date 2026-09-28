/**
 * The sidebar's Active/Done split, as the thread fold records it.
 *
 * Two timestamps and one rule: `doneAt` is when the user marked the thread
 * done, `lastActivityAt` is the last time something happened that the user
 * would call activity, and the thread is marked done while
 * `doneAt >= lastActivityAt`. A later turn, steer, queued message, completion,
 * unarchive or reopen therefore brings it back without an event of its own.
 * Auto-done (the `autoDoneAfterDays` setting) is worked out on the client from
 * `lastActivityAt`; the server never stores it.
 */

import type { OrchestrationEventType, ThreadSummary } from "@poseidon/contracts/orchestration";

import type { ThreadDoc } from "./state";

/**
 * The events that count as activity. `thread.done.cleared` is one because the
 * client sends it when the user opens a done thread: opening it is activity.
 */
const ACTIVITY_EVENTS: ReadonlySet<OrchestrationEventType> = new Set<OrchestrationEventType>([
  "thread.created",
  "thread.turn.requested",
  "thread.turn.steered",
  "thread.message.queued",
  "thread.turn.completed",
  "thread.unarchived",
  "thread.done.cleared",
]);

/** The fold's stamp for one event: `lastActivityAt` when it counts as activity. */
export const activityStamp = (event: {
  readonly type: OrchestrationEventType;
  readonly occurredAt: string;
}): { readonly lastActivityAt?: string } =>
  ACTIVITY_EVENTS.has(event.type) ? { lastActivityAt: event.occurredAt } : {};

/** When the thread was marked done, tolerating a document written before it could be. */
export const doneAtOf = (doc: ThreadDoc): string | null =>
  (doc.doneAt as string | null | undefined) ?? null;

/**
 * The thread's last activity. A document projected before the field existed
 * has none; its `updatedAt` is the closest thing it recorded.
 */
export const lastActivityOf = (doc: ThreadDoc): string => doc.lastActivityAt ?? doc.updatedAt;

/** The summary's `doneAt` (only when set) and `lastActivityAt` (always). */
export const doneSummaryFields = (
  doc: ThreadDoc,
): Pick<ThreadSummary, "doneAt" | "lastActivityAt"> => {
  const doneAt = doneAtOf(doc);
  return {
    ...(doneAt === null ? {} : { doneAt }),
    lastActivityAt: lastActivityOf(doc),
  };
};
