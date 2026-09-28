/**
 * What the attention coordinator decides, kept pure so it can be tested
 * without a window: which thread transitions are worth telling the user
 * about, how loudly, and the counts behind the Dock badge, keep-awake and the
 * quit guard.
 *
 * A transition is found by diffing two thread lists. The first loaded list
 * only seeds the baseline — every thread in it is already in whatever state
 * it is in, so a reload, a reconnect or a snapshot replay never alerts. After
 * that each thread reports at most one event per diff, the loudest one:
 *
 * - `failed`: any other status became `error`.
 * - `needsYou`: an approval, a question or a ready plan opened, or a different
 *   one replaced it. While the same one stays open, nothing repeats; once it
 *   resolves, the next one alerts again.
 * - `finished`: a `running` or `waiting` thread went `idle`.
 *
 * A thread the baseline has not seen (just created) and archived or deleted
 * threads say nothing.
 */

import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";
import type { NotificationSettings } from "@poseidon/contracts/settings";
import { Check } from "@honeyicons/react";

import { type ThreadStatusMark, threadStatusMark } from "@/components/sidebar/thread-status";

/** What a thread waits on the user for, or `null` when nothing. */
export type Attention = "approval" | "question" | "plan";

export type AttentionKind = "finished" | "failed" | "needsYou";

export interface AttentionEvent {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly kind: AttentionKind;
  /** For `needsYou`, what it waits on; picks "Needs you" or "Plan ready". */
  readonly attention: Attention | null;
}

interface ThreadState {
  readonly status: ThreadSummary["status"];
  readonly attention: Attention | null;
}

export type Snapshot = ReadonlyMap<ThreadId, ThreadState>;

type Summary = Pick<ThreadSummary, "status" | "awaitingInput" | "awaiting">;

/** The fields of a thread summary the coordinator reads. */
export type AttentionThread = Pick<
  ThreadSummary,
  "threadId" | "title" | "status" | "awaitingInput" | "awaiting"
>;

/**
 * What the thread waits on. A summary without `awaiting` (written before it
 * existed), or a `waiting` status with no open decision, reads as an
 * approval: the louder guess, as the sidebar's mark makes it.
 */
export const attentionOf = (thread: Summary): Attention | null => {
  if (thread.awaiting !== undefined) return thread.awaiting;
  return thread.awaitingInput || thread.status === "waiting" ? "approval" : null;
};

const gone = (status: ThreadSummary["status"]): boolean =>
  status === "archived" || status === "deleted";

export const snapshotOf = (list: ReadonlyArray<AttentionThread>): Snapshot =>
  new Map(
    list.map((thread) => [
      thread.threadId,
      { status: thread.status, attention: attentionOf(thread) },
    ]),
  );

const kindOf = (prev: ThreadState, next: AttentionThread): AttentionKind | null => {
  const attention = attentionOf(next);
  if (next.status === "error" && prev.status !== "error") return "failed";
  if (attention !== null && attention !== prev.attention) return "needsYou";
  if (next.status === "idle" && (prev.status === "running" || prev.status === "waiting")) {
    return attention === null ? "finished" : null;
  }
  return null;
};

/** The events between two lists; none on the first one (`prev` null). */
export const transitions = (
  prev: Snapshot | null,
  next: ReadonlyArray<AttentionThread>,
): ReadonlyArray<AttentionEvent> => {
  if (prev === null) return [];
  const events: Array<AttentionEvent> = [];
  for (const thread of next) {
    const before = prev.get(thread.threadId);
    if (before === undefined || gone(thread.status)) continue;
    const kind = kindOf(before, thread);
    if (kind === null) continue;
    events.push({
      threadId: thread.threadId,
      title: thread.title,
      kind,
      attention: kind === "needsYou" ? attentionOf(thread) : null,
    });
  }
  return events;
};

/** Threads waiting on an approval, a question or a ready plan: the Dock badge. */
export const needsYouCount = (list: ReadonlyArray<AttentionThread>): number =>
  list.filter((thread) => !gone(thread.status) && attentionOf(thread) !== null).length;

/** Threads a quit would interrupt: in a turn, or waiting on the user. */
export const busyThreads = <T extends AttentionThread>(list: ReadonlyArray<T>): ReadonlyArray<T> =>
  list.filter(
    (thread) =>
      !gone(thread.status) &&
      (thread.status === "running" || thread.status === "waiting" || attentionOf(thread) !== null),
  );

/** Whether any agent is in a turn: what keep-awake holds for. */
export const anyRunning = (list: ReadonlyArray<Pick<ThreadSummary, "status">>): boolean =>
  list.some((thread) => thread.status === "running");

export type AlertChannel = "none" | "toast" | "os";

/**
 * How to tell the user: nothing for the thread they are looking at in a
 * focused window, a toast for another thread while the window is focused, a
 * system notification when the window is in the background or hidden.
 */
export const shouldAlert = (
  event: Pick<AttentionEvent, "threadId">,
  view: { readonly openThreadId: string | null; readonly focused: boolean },
): AlertChannel => {
  if (!view.focused) return "os";
  return event.threadId === view.openThreadId ? "none" : "toast";
};

export const eventEnabled = (kind: AttentionKind, settings: NotificationSettings): boolean =>
  settings[kind];

const FINISHED: ThreadStatusMark = { icon: Check, label: "Finished", tone: "text-foreground" };

/** The icon, label and tone an alert shows: the sidebar's own marks. */
export const eventMark = (event: Pick<AttentionEvent, "kind" | "attention">): ThreadStatusMark => {
  switch (event.kind) {
    case "finished":
      return FINISHED;
    case "failed":
      return threadStatusMark({ status: "error", awaitingInput: false }) ?? FINISHED;
    case "needsYou":
      return (
        threadStatusMark({
          status: "waiting",
          awaitingInput: true,
          ...(event.attention === null ? {} : { awaiting: event.attention }),
        }) ?? FINISHED
      );
  }
};
