/**
 * `thread/tokenUsage/updated` → the turn's usage and the context it leaves.
 *
 * The server sends the thread's token count after each model request, in two
 * breakdowns: `total`, a running sum for the whole thread — carried across a
 * resume, since the CLI keeps it in its rollout — and `last`, that one
 * request. So a turn's usage is how far `total` moved since the turn began.
 * The thread's total before the turn is the last one the session saw; a turn
 * whose first update is also the first the session has seen (a fresh thread)
 * starts from that update's `total` less its `last`.
 *
 * OpenAI counts cached input inside `inputTokens`; Poseidon's `input` is the
 * uncached part, as Claude's is, and the cached part is `cacheRead`.
 *
 * The context in use is the last request's whole count, measured against the
 * `modelContextWindow` the server names beside it.
 */

import type { TurnId } from "@poseidon/contracts/ids";

import { asNumber, asRecord, tokens, type Json, type PendingRuntimeEvent } from "./pending";

interface Breakdown {
  readonly input: number;
  readonly cached: number;
  readonly cacheWrite: number;
  readonly output: number;
}

const breakdownOf = (value: unknown): Breakdown => {
  const record = asRecord(value);
  return {
    input: tokens(record.inputTokens),
    cached: tokens(record.cachedInputTokens),
    cacheWrite: tokens(record.cacheWriteInputTokens),
    output: tokens(record.outputTokens),
  };
};

const minus = (a: Breakdown, b: Breakdown): Breakdown => ({
  input: Math.max(0, a.input - b.input),
  cached: Math.max(0, a.cached - b.cached),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  output: Math.max(0, a.output - b.output),
});

export interface UsageTracker {
  /** One `thread/tokenUsage/updated`, inside `turnId`'s turn or outside any. */
  readonly update: (params: Json, turnId: TurnId | null) => ReadonlyArray<PendingRuntimeEvent>;
  /** A new turn: its baseline is taken at its first update. */
  readonly startTurn: () => void;
}

export const makeUsageTracker = (): UsageTracker => {
  let lastTotal: Breakdown | null = null;
  let baseline: Breakdown | null = null;

  return {
    startTurn: () => {
      baseline = null;
    },
    update: (params, turnId) => {
      const usage = asRecord(params.tokenUsage);
      const total = breakdownOf(usage.total);
      const last = breakdownOf(usage.last);
      const events: Array<PendingRuntimeEvent> = [];
      if (turnId !== null) {
        baseline ??= lastTotal ?? minus(total, last);
        const turn = minus(total, baseline);
        events.push({
          type: "usage.updated",
          payload: {
            turnId,
            input: Math.max(0, turn.input - turn.cached),
            output: turn.output,
            cacheRead: turn.cached,
            cacheWrite: turn.cacheWrite,
          },
        });
      }
      lastTotal = total;
      const window_ = asNumber(usage.modelContextWindow);
      const used = tokens(asRecord(usage.last).totalTokens);
      if (window_ !== undefined && window_ > 0 && used > 0) {
        events.push({
          type: "context.updated",
          payload: { used, limit: Math.trunc(window_) },
        });
      }
      return events;
    },
  };
};
