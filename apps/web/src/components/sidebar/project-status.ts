/**
 * The one status mark a folded project's header shows for the threads it
 * hides.
 *
 * Folding a project lists only the open thread (`./thread-order`), so a
 * thread that stops for an approval, or fails, behind a folded header was
 * invisible until the project was opened again — the fold hid exactly the
 * rows the user most needed to see. The header now carries the most urgent
 * mark among them, drawn from the same `threadStatusMark` as the rows, so an
 * approval pending mid-turn counts as Needs you here too, and the icon and
 * tone match the row it stands for.
 *
 * Priority: Needs you > Plan ready > running (Working and Thinking share a
 * tier) > Error. What blocks the user comes first, then what waits on a
 * review, then what is still moving; a failure is reported last because
 * nothing more will happen to it. The open thread is skipped (it stays
 * listed, with its own mark), and so are archived and deleted threads.
 */

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { type ThreadStatusMark, threadStatusMark } from "./thread-status";

/** What a folded project's header draws, or `null` when nothing is worth it. */
export interface ProjectStatusRollup {
  /** The mark of the first thread in the winning tier. */
  readonly mark: ThreadStatusMark;
  /** How many threads are in the winning tier. */
  readonly count: number;
  /** Both the tooltip and the accessible name. */
  readonly label: string;
}

type RollupThread = Pick<
  ThreadSummary,
  "threadId" | "status" | "awaitingInput" | "awaiting" | "activity"
>;

const TIER_OF_LABEL: Readonly<Record<string, number>> = {
  "Needs you": 4,
  "Plan ready": 3,
  Working: 2,
  Thinking: 2,
  Error: 1,
};

const tierLabel = (tier: number, count: number): string => {
  const one = count === 1;
  const threads = `${count} ${one ? "thread" : "threads"}`;
  switch (tier) {
    case 4:
      return `${threads} ${one ? "needs" : "need"} you`;
    case 3:
      return `${threads} ${one ? "has" : "have"} a plan ready`;
    case 2:
      return `${threads} working`;
    default:
      return `${threads} failed`;
  }
};

export const projectStatusRollup = (
  threads: ReadonlyArray<RollupThread>,
  openThreadId: string | null,
): ProjectStatusRollup | null => {
  let tier = 0;
  let mark: ThreadStatusMark | null = null;
  let count = 0;
  for (const thread of threads) {
    if (
      thread.threadId === openThreadId ||
      thread.status === "archived" ||
      thread.status === "deleted"
    ) {
      continue;
    }
    const threadMark = threadStatusMark(thread);
    const threadTier = threadMark === null ? 0 : (TIER_OF_LABEL[threadMark.label] ?? 0);
    if (threadTier > tier) {
      tier = threadTier;
      mark = threadMark;
      count = 1;
    } else if (threadTier > 0 && threadTier === tier) {
      count += 1;
    }
  }
  return mark === null ? null : { mark, count, label: tierLabel(tier, count) };
};
