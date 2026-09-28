/**
 * Starting threads without leaving New task, as injected steps so every way
 * through can be tested without a server. One lane is one new thread: "Start
 * in background" runs one, "Compare models" one per model
 * (`fan-out-plan.ts` plans them).
 *
 * A lane with a `worktree` goes through `start-in-worktree.ts` — create the
 * worktree, run setup, create the thread in it, send — but nobody is on a
 * start screen to answer a failure, so each one is settled here:
 *
 * - the worktree could not be created: `failed`, nothing to clean up;
 * - setup failed: the thread is still created, as "Start anyway" would, and
 *   the draft is parked in its composer instead of sent: `parked`, with how
 *   the script ended;
 * - `thread.create` was refused after the worktree was cut: the worktree is
 *   discarded (the caller forces it; the branch is kept): `failed`;
 * - the first send failed: the draft is parked: `parked`.
 *
 * A lane without one creates the thread and sends. `runBackgroundLanes` runs
 * several: `git worktree add` on one repository races on git's locks, so the
 * worktree creates go one after another in lane order. Setup, create and send
 * then overlap across lanes, except that each thread create waits until the
 * lane before it has issued its own (or ended without one), so the new rows
 * land in the sidebar together and in order. That wait gives up after
 * `TURN_WAIT_MS`: a lane whose setup runs on (a watcher it started, a prompt
 * nobody answers) must not keep the lanes after it from their threads.
 */

import type { WorktreeSetupProgress } from "@poseidon/client-runtime/gitCommands";
import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";

import {
  finishInWorktree,
  startInWorktree,
  type WorktreeStartSteps,
} from "@/components/thread/start-in-worktree";

/** What a lane's worktree is asked for with; the server slugs the name. */
export interface LaneWorktree {
  readonly name: string;
  readonly baseBranch?: string;
}

export interface BackgroundLane {
  readonly threadId: ThreadId;
  readonly title?: string;
  readonly settings: ThreadSettingsPatch;
  /** Absent: a local thread on the project's root. */
  readonly worktree?: LaneWorktree;
}

export interface BackgroundLaneSteps {
  /** Rejects with the server's refusal. */
  readonly createWorktree: (worktree: LaneWorktree) => Promise<ThreadWorktree>;
  /** As in `start-in-worktree.ts`: a rejection's `message` is the reason. */
  readonly runSetup: (worktree: ThreadWorktree) => Promise<WorktreeSetupProgress>;
  /** `thread.create`; resolves with the refusal's message, or null once it exists. */
  readonly createThread: (
    lane: BackgroundLane,
    worktree: ThreadWorktree | undefined,
  ) => Promise<string | null>;
  /** Sends the draft as the thread's first turn; the error message, or null. */
  readonly sendFirstTurn: (threadId: ThreadId) => Promise<string | null>;
  /** Leaves the draft unsent in the thread's own composer. */
  readonly parkDraft: (threadId: ThreadId) => void;
  /** Removes a worktree whose thread was refused. */
  readonly discardWorktree: (worktree: ThreadWorktree) => Promise<void>;
}

export type BackgroundOutcome =
  | { readonly _tag: "started"; readonly threadId: ThreadId }
  /** The thread exists, but the message did not go; it waits in the composer. */
  | { readonly _tag: "parked"; readonly threadId: ThreadId; readonly reason: string }
  /** No thread exists. */
  | { readonly _tag: "failed"; readonly reason: string };

const THREAD_REFUSED = "The thread could not be created";

const messageOf = (error: unknown, fallback: string): string =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string" &&
  error.message !== ""
    ? error.message
    : fallback;

/**
 * Runs tasks one after another in the order they were handed in, whether or
 * not the ones before succeeded — for git's worktree creates here, and for
 * anything else the lanes must not do at once (staging attachments).
 */
export const serialized = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <A>(task: () => Promise<A>): Promise<A> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
};

/**
 * How long a lane ready to create its thread waits for the lane before it to
 * create its own; past this the rows may land out of order, but they land.
 */
const TURN_WAIT_MS = 10_000;

/** Settles when `promise` does, or after `ms`, whichever comes first. */
const waitAtMost = async (promise: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** How one lane shares the repository and the sidebar with its siblings. */
interface LaneGates {
  readonly serial: ReturnType<typeof serialized>;
  /** Settles once the lane before has issued its thread create, or ended. */
  readonly turn: Promise<void>;
  /** At most how long the lane waits on `turn`. */
  readonly turnWaitMs: number;
  /** This lane has issued its thread create, or will not. */
  readonly passTurn: () => void;
}

const soloGates = (): LaneGates => ({
  serial: serialized(),
  turn: Promise.resolve(),
  turnWaitMs: 0,
  passTurn: () => undefined,
});

const runLane = async (
  lane: BackgroundLane,
  steps: BackgroundLaneSteps,
  gates: LaneGates,
): Promise<BackgroundOutcome> => {
  const createThread = async (worktree: ThreadWorktree | undefined): Promise<string | null> => {
    await waitAtMost(gates.turn, gates.turnWaitMs);
    const pending = steps.createThread(lane, worktree);
    gates.passTurn();
    try {
      return await pending;
    } catch (error) {
      return messageOf(error, THREAD_REFUSED);
    }
  };

  const send = async (): Promise<BackgroundOutcome> => {
    let error: string | null;
    try {
      error = await steps.sendFirstTurn(lane.threadId);
    } catch (cause) {
      error = messageOf(cause, "The message could not be sent");
    }
    if (error === null) {
      return { _tag: "started", threadId: lane.threadId };
    }
    steps.parkDraft(lane.threadId);
    return { _tag: "parked", threadId: lane.threadId, reason: error };
  };

  const refused = async (worktree: ThreadWorktree, reason: string): Promise<BackgroundOutcome> => {
    try {
      await steps.discardWorktree(worktree);
    } catch (error) {
      return {
        _tag: "failed",
        reason: `${reason}; its worktree at ${worktree.path} was not removed: ${messageOf(error, "unknown error")}`,
      };
    }
    return { _tag: "failed", reason };
  };

  try {
    const request = lane.worktree;
    if (request === undefined) {
      const refusal = await createThread(undefined);
      return refusal === null ? await send() : { _tag: "failed", reason: refusal };
    }

    // Written by the steps below, read once the sequence has an outcome.
    const seen: { refusal: string | null; sending: Promise<BackgroundOutcome> | null } = {
      refusal: null,
      sending: null,
    };
    const worktreeSteps: WorktreeStartSteps = {
      createWorktree: () => gates.serial(() => steps.createWorktree(request)),
      runSetup: steps.runSetup,
      createThread: async (worktree) => {
        seen.refusal = await createThread(worktree);
        return seen.refusal === null;
      },
      send: () => {
        seen.sending = send();
      },
    };

    const outcome = await startInWorktree(worktreeSteps);
    switch (outcome._tag) {
      case "started":
        return seen.sending ?? { _tag: "started", threadId: lane.threadId };
      case "not-created":
        return { _tag: "failed", reason: outcome.message };
      case "thread-rejected":
        return refused(outcome.worktree, seen.refusal ?? THREAD_REFUSED);
      case "abandoned":
        // No `abandoned` step is given, so the sequence never stops this way.
        return { _tag: "failed", reason: "The start was abandoned" };
      case "setup-failed": {
        // "Start anyway", with the draft parked in place of the send.
        const finish = await finishInWorktree(
          { ...worktreeSteps, send: () => steps.parkDraft(lane.threadId) },
          outcome.worktree,
        );
        return finish._tag === "started"
          ? { _tag: "parked", threadId: lane.threadId, reason: outcome.reason }
          : refused(outcome.worktree, seen.refusal ?? THREAD_REFUSED);
      }
    }
  } finally {
    // A lane that ended before its create must not hold the next one back.
    gates.passTurn();
  }
};

/** One lane on its own ("Start in background"). */
export const runBackgroundLane = (
  lane: BackgroundLane,
  steps: BackgroundLaneSteps,
): Promise<BackgroundOutcome> => runLane(lane, steps, soloGates());

/** Several lanes at once; outcomes in lane order. */
export const runBackgroundLanes = (
  lanes: ReadonlyArray<BackgroundLane>,
  steps: BackgroundLaneSteps,
  turnWaitMs: number = TURN_WAIT_MS,
): Promise<ReadonlyArray<BackgroundOutcome>> => {
  const serial = serialized();
  let turn: Promise<void> = Promise.resolve();
  const runs = lanes.map((lane) => {
    let passTurn: () => void = () => undefined;
    const passed = new Promise<void>((resolve) => {
      passTurn = resolve;
    });
    const run = runLane(lane, steps, { serial, turn, turnWaitMs, passTurn });
    turn = passed;
    return run;
  });
  return Promise.all(runs);
};

export interface BackgroundSummary {
  readonly title: string;
  /** The lanes that did not start, and why; when all of several started, their names. */
  readonly description?: string;
  readonly tone: "success" | "warning" | "error";
  /** Where the toast's Open goes: the first thread that started, else the first that exists. */
  readonly openThreadId: ThreadId | null;
}

/** The toast for a finished background start; `labels[i]` names lane `i` (the model). */
export const backgroundSummary = (
  projectName: string,
  outcomes: ReadonlyArray<BackgroundOutcome>,
  labels: ReadonlyArray<string | undefined> = [],
): BackgroundSummary => {
  const total = outcomes.length;
  const started = outcomes.filter((outcome) => outcome._tag === "started");
  const parked = outcomes.filter((outcome) => outcome._tag === "parked");
  const existing = started.length + parked.length;

  const notes = outcomes.flatMap((outcome, index) => {
    if (outcome._tag === "started") {
      return [];
    }
    const label = labels[index];
    const note =
      outcome._tag === "parked"
        ? `${outcome.reason} — the message waits in the thread's composer`
        : outcome.reason;
    return [label === undefined ? note : `${label}: ${note}`];
  });

  const title =
    total === 1
      ? existing === 0
        ? `Could not start in ${projectName}`
        : started.length === 1
          ? `Started in ${projectName}`
          : `Created a thread in ${projectName}`
      : started.length === total
        ? `Started ${total} threads in ${projectName}`
        : existing === 0
          ? `Could not start ${total} threads in ${projectName}`
          : `Started ${started.length} of ${total} threads in ${projectName}`;

  // Every lane of a fan-out started: the toast names the models instead.
  const names = labels.filter((label) => label !== undefined);
  const description =
    notes.length > 0 ? notes.join("; ") : total > 1 && names.length > 0 ? names.join(", ") : null;

  return {
    title,
    ...(description === null ? {} : { description }),
    tone: started.length === total ? "success" : existing === 0 ? "error" : "warning",
    openThreadId: started[0]?.threadId ?? parked[0]?.threadId ?? null,
  };
};
