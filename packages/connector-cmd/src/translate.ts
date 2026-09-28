/**
 * Command Code frames and transcript lines → `RuntimeEvent`s.
 *
 * Three sources describe the same work and overlap heavily: NDJSON frames on
 * stdout, the session transcript on disk, and — on `run_end` —
 * `nextState.messages`, the authoritative message list.
 *
 * **Which source is live.** The recordings under `packages/testkit/fixtures/cmd`
 * settle it. Text and thinking stream as `text_delta` /
 * `thinking_delta`, tool calls arrive as a `tool_queued` → `tool_running` →
 * `tool_completed` lifecycle, and the transcript is *not* a live source: it
 * appears seconds into the turn and then grows once per completed message, one
 * whole model round trip behind the frames. So the frames drive the UI and the
 * transcript is history — the thing that survives a restart, carries `costUsd`,
 * and lets a resumed session pick up where a dead one stopped.
 *
 * **What a "turn" is.** The harness's `turn_start`/`turn_end` count *agent
 * steps* — one model round trip each, three of them in `shell-allow/`. One user
 * turn is one process: `run_start` to `run_end`. Mapping `turn_start` to
 * `turn.started` emitted three `turn.started` events for one turn and one
 * `turn.completed`, so `run_start` is what opens a turn here.
 *
 * The translator's remaining job is to make the overlap idempotent:
 *
 * - tool calls dedupe on `tool_use.id`: a `tool_running` frame and the
 *   transcript's `tool_use` block produce one `itemId`, so the second source
 *   updates rather than duplicates.
 * - messages dedupe on `meta.messageId`: the transcript append and the
 *   `run_end` reconcile both feed through the same message path.
 * - `turn.completed` emits exactly once per run: `run_end` normally closes it,
 *   `onExit` is the backstop for a process that died mid-turn.
 *
 * Item ids are minted — the harness's `toolCallId`/`messageId` are not UUIDv7
 * and the wire schema insists on it — and kept in maps so a later event for
 * the same work lands on the same timeline row.
 */

import { makeTurnId } from "@poseidon/contracts/ids";
import { EFFORT_ORDER, type Effort } from "@poseidon/contracts/enums";
import type { ConnectorCapabilities, TurnStopReason } from "@poseidon/contracts/runtime";

import { EXIT_MESSAGES } from "./exitCodes";
import {
  ASK_USER_QUESTION,
  asCompactionTokens,
  asOptionalString,
  asRecord,
  asString,
  makeToolRows,
  textOfToolResult,
  truncateToolOutput,
  type PendingRuntimeEvent,
  type TranscriptLine,
  type TranscriptMessage,
} from "./items";
import type { CmdFrame, CmdUsage } from "./ndjson";
import { deltaEvents } from "./deltas";
import { isPlanWrite, PLAN_SAVED } from "./plans";
import { subagentProgress } from "./subagents";
import { makeMessageFolder } from "./messages";
import { makeTextRows } from "./textRows";

export type { PendingRuntimeEvent } from "./items";

/** A frame's `effort`, when it is one the contract knows. */
const asEffort = (value: unknown): Effort | undefined =>
  typeof value === "string" && (EFFORT_ORDER as ReadonlyArray<string>).includes(value)
    ? (value as Effort)
    : undefined;

export interface CmdTranslator {
  /** One stdout frame → the events it means. */
  readonly onFrame: (frame: CmdFrame) => ReadonlyArray<PendingRuntimeEvent>;
  /** One transcript line, already JSON-parsed → the events it means. */
  readonly onTranscriptLine: (line: unknown) => ReadonlyArray<PendingRuntimeEvent>;
  /** Process exit → the events that settle whatever is still open. */
  readonly onExit: (code: number) => ReadonlyArray<PendingRuntimeEvent>;
  /** The session id learned from `run_start` (or the transcript header). */
  readonly sessionId: string | null;
  /**
   * The id of the newest transcript message folded into items —
   * `meta.messageId`, or the transcript line's own `id` when the message is
   * anonymous. Persisted in the sessionRef so a resumed runtime can dedupe
   * against what a previous process already emitted.
   */
  readonly lastMessageId: string | null;
}

// ── the translator ─────────────────────────────────────────────

export const makeTranslator = (options: {
  readonly connectorInstanceId: unknown;
  readonly capabilities: ConnectorCapabilities;
  /**
   * The persisted ref's marker on a resumed session. The tailer repositions
   * the file after it; a `nextState` replay that contains it has its
   * already-emitted prefix skipped (a fresh `seenMessages` would otherwise
   * duplicate every message the previous runtime folded).
   */
  readonly resumeAfterMessageId?: string | null;
  /**
   * Tokens the model can hold, from `status --json`'s `context_window`. Every
   * `run_end` reports the tokens the conversation now occupies; without the
   * ceiling there is no percentage to report, so `context.updated` is simply
   * not emitted.
   */
  readonly contextLimit?: number | null;
}): CmdTranslator => {
  let sessionId: string | null = null;
  let announced = false;
  let model: string | null = null;
  /** The effort the last `model_request_end` reported, so it is said once. */
  let lastEffort: Effort | null = null;
  let turnOpen = false;
  let lastMessageId: string | null = options.resumeAfterMessageId ?? null;
  let resumeMarker = options.resumeAfterMessageId ?? null;
  /** A tool call's row, however many frames and transcript lines describe it. */
  const toolRows = makeToolRows();
  /** Which row a piece of assistant text belongs on, across all three sources. */
  const textRows = makeTextRows();
  let deltaRun = 0;
  /** Cost the transcript reported for this turn's assistant messages. */
  let turnCostUsd = 0;
  const costedLines = new Set<string>();
  /** Tokens the run's agent steps have reported so far (`turn_end.usage`). */
  let turnUsage: CmdUsage = {};
  /**
   * One failure, one error row.
   *
   * Three paths describe the same death — the `run_error` frame, the final
   * `result` frame with `subtype: "error"`, and the exit code — and since every
   * fatal `runtime.error` also plants its own `error` row on the timeline, an
   * out-of-credits turn showed three red rows and moved the thread to `error`
   * three times. The `result` frame carries the wording worth showing (it is
   * the one with the billing URL), so `run_error` only *holds* its message and
   * the exit code is the backstop for a run that never got that far.
   */
  let reportedFatal = false;
  let heldFatal: string | null = null;

  /**
   * A run's counters, zeroed when the next process announces itself.
   *
   * Not at `turn.completed`, which is where they used to be cleared: the
   * transcript is the only source of `costUsd` and its last flush lands *with*
   * or after `run_end`, so a cost cleared at turn end was a cost never reported.
   * The same goes for the text rows' reverse index, which is how a transcript
   * line arriving after the turn finds the row it already streamed on — it
   * lives as long as the session, beside `seenMessages`.
   */
  const forgetRun = (): void => {
    textRows.forgetRun();
    turnCostUsd = 0;
    turnUsage = {};
    reportedFatal = false;
    heldFatal = null;
  };

  /** The run's one fatal error, or nothing when it has already been reported. */
  const fatalError = (message: string): ReadonlyArray<PendingRuntimeEvent> => {
    if (reportedFatal) {
      return [];
    }
    reportedFatal = true;
    heldFatal = null;
    return [{ type: "runtime.error", payload: { message, fatal: true } }];
  };

  const unmapped = (source: string, payload: unknown): PendingRuntimeEvent => ({
    type: "event.unmapped",
    payload: {},
    raw: { source, payload },
  });

  const { processMessage, onMessageContent } = makeMessageFolder({ toolRows, textRows, unmapped });

  /**
   * `run_end.result.usage` has no cost field — the only place a
   * price appears is the transcript's per-assistant `usage.costUsd`, so
   * the turn's cost is the sum of the lines it wrote. Zero stays absent rather
   * than being reported as a free turn.
   */
  /**
   * Every `usage.updated` is a snapshot of the run so far, never a delta: the
   * counters are cumulative and are zeroed only when the next process starts
   * (`forgetRun`). A turn whose price arrives late therefore restates the whole
   * figure rather than asking the consumer to add up instalments — and every
   * one of them carries the running cost, because the projection replaces the
   * usage object rather than merging into it, so an update that left the cost
   * out erased it from the screen mid-turn.
   */
  const usageUpdated = (usage: CmdUsage | undefined): PendingRuntimeEvent => {
    const costUsd = turnCostUsd;
    return {
      type: "usage.updated",
      payload: {
        turnId: makeTurnId(),
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        cacheRead: usage?.cacheReadTokens ?? 0,
        cacheWrite: usage?.cacheWriteTokens ?? 0,
        ...(costUsd > 0 ? { costUsd } : {}),
      },
    };
  };

  /**
   * The running token total of the agent steps finished so far. `run_end`
   * reports the same figure for the whole run, so this is only what makes the
   * count move while a multi-step turn is still working — `shell-allow/` spends
   * 26 seconds over three steps before its `run_end`.
   */
  const accumulate = (usage: CmdUsage | undefined): void => {
    turnUsage = {
      inputTokens: (turnUsage.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
      outputTokens: (turnUsage.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
      cacheReadTokens: (turnUsage.cacheReadTokens ?? 0) + (usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: (turnUsage.cacheWriteTokens ?? 0) + (usage?.cacheWriteTokens ?? 0),
    };
  };

  const stopReasonFor = (reason: string | undefined): TurnStopReason => {
    switch (reason) {
      case "end_turn":
      case "stop":
        return "end_turn";
      case "interrupted":
      case "cancelled":
        return "interrupted";
      case "max_turns":
        return "max_turns";
      default:
        return "error";
    }
  };

  const completeTurn = (stopReason: TurnStopReason): PendingRuntimeEvent => {
    turnOpen = false;
    return { type: "turn.completed", payload: { turnId: makeTurnId(), stopReason } };
  };

  const onRunStart = (event: { sessionId?: string }): ReadonlyArray<PendingRuntimeEvent> => {
    const id = event.sessionId;
    // A second run_start for the same session is the next turn's process —
    // announce once. A *different* id means the resume landed on a fresh
    // session, which the engine needs to hear about.
    if (announced && (id === undefined || id === sessionId)) {
      turnOpen = true;
      forgetRun();
      return [];
    }
    if (id !== undefined) {
      sessionId = id;
    }
    announced = true;
    turnOpen = true;
    forgetRun();
    return [
      {
        type: "session.started",
        payload: {
          sessionRef: { sessionId, transcriptPath: null, cwd: null },
          model: model ?? "unknown",
          capabilities: options.capabilities,
        },
      },
    ];
  };

  const isRefusedPlanWrite = (event: { readonly [key: string]: unknown }): boolean =>
    isPlanWrite(event.toolName, toolRows.inputFor(asString(event.toolCallId)));

  const planWriteRow = (event: {
    readonly [key: string]: unknown;
  }): ReadonlyArray<PendingRuntimeEvent> =>
    toolRows.finished(
      asString(event.toolCallId),
      asString(event.toolName) ?? "write_file",
      PLAN_SAVED,
      false,
    );

  const onFrame = (frame: CmdFrame): ReadonlyArray<PendingRuntimeEvent> => {
    if (frame.type === "result") {
      const out: Array<PendingRuntimeEvent> = [];
      if (frame.subtype === "error") {
        // The summary line, and the one the CLI puts the actionable wording in
        // — so it supersedes whatever `run_error` was holding.
        out.push(...fatalError(frame.error ?? "command code run failed"));
      }
      if (turnOpen) {
        out.push(
          completeTurn(
            frame.subtype === "max_turns"
              ? "max_turns"
              : frame.subtype === "error"
                ? "error"
                : "end_turn",
          ),
        );
      }
      return out;
    }

    const event = frame.event;
    switch (event.type) {
      case "run_start": {
        // One process is one user turn. The harness's
        // own `turn_start` counts agent steps inside it.
        return [...onRunStart(event), { type: "turn.started", payload: { turnId: makeTurnId() } }];
      }
      case "turn_start": {
        turnOpen = true;
        deltaRun += 1;
        return [];
      }
      case "turn_end": {
        // The step's tokens. `model_request_end` reports the same numbers one
        // frame earlier, so only one of the two may be counted.
        accumulate(event.usage as CmdUsage | undefined);
        // With the cost, because the projection replaces the whole usage object
        // rather than merging into it: a cost-less update mid-turn wiped the
        // dollar figure the transcript had just reported and the user watched
        // it blink out (`shell-allow` is three agent steps over 26 seconds).
        // `usageUpdated` omits the field while the running cost is 0, and the
        // counters are cumulative snapshots, so restating it is idempotent.
        return [usageUpdated(turnUsage)];
      }
      case "message_start":
      case "message_update":
      case "model_trace":
      case "thinking_start":
      case "notice": {
        // Recognized and deliberately silent. `message_update` re-sends the
        // whole message on every delta — the deltas already stream it and
        // `message_end` closes it — and `thinking_start` carries nothing the
        // first `thinking_delta` does not open.
        return [];
      }
      case "model_request_start": {
        // One model_request_start fires per request, not per change — emit
        // only when the value actually moved or thread.settings.updated
        // spam feeds back into the reactor.
        if (event.model === undefined || event.model === model) {
          return [];
        }
        model = event.model;
        return [{ type: "model.changed", payload: { model: event.model } }];
      }
      case "model_request_end": {
        // Usage is `turn_end`'s to report (counting both would double the
        // turn). The model and the effort it actually ran at are worth taking:
        // this is the only frame that names the effort, and on the account
        // default it is `xhigh` — a level the model picker never offered and
        // the header never showed, so a run at xhigh read as a run at whatever
        // the thread's settings last said.
        const effort = asEffort(event.effort);
        const changed = event.model !== undefined && event.model !== model;
        if (!changed && (effort === undefined || effort === lastEffort)) {
          return [];
        }
        if (event.model !== undefined) {
          model = event.model;
        }
        if (effort !== undefined) {
          lastEffort = effort;
        }
        const named = event.model ?? model;
        if (named === null) {
          return [];
        }
        return [
          {
            type: "model.changed",
            payload: { model: named, ...(effort === undefined ? {} : { effort }) },
          },
        ];
      }
      case "message_end": {
        // The finished message. Its text and thinking blocks settle the rows
        // the deltas opened — without this the timeline waits for the
        // transcript, a whole model round trip later. Tool calls in it are the
        // same ones `tool_queued` announces, and dedupe on `toolCallId`.
        return [...onMessageContent(event.content)];
      }
      case "thinking_end": {
        const text = asOptionalString(event.text);
        if (text === undefined) {
          return [];
        }
        const itemId = textRows.streamedFor(text) ?? textRows.idFor(`thinking_end:${deltaRun}`);
        textRows.settle(itemId);
        return [
          {
            itemId,
            type: "item.completed",
            payload: { item: { itemId, kind: "reasoning", status: "completed", text } },
          },
        ];
      }
      case "tool_queued": {
        // Where a tool call's input lives: `tool_running` announces neither
        // input nor description.
        return [...toolRows.started(event.toolCallId, event.toolName ?? "unknown", event.input)];
      }
      case "tool_running": {
        return [
          ...toolRows.started(
            event.toolCallId,
            event.toolName ?? "unknown",
            undefined,
            asOptionalString(event.description),
          ),
        ];
      }
      case "tool_update": {
        // A long-running tool streaming its output as it goes.
        return [
          ...toolRows.progressed(
            event.toolCallId,
            asString(event.partial) ?? textOfToolResult(event.partial),
          ),
        ];
      }
      case "tool_completed": {
        return [
          ...toolRows.finished(
            event.toolCallId,
            event.toolName ?? "unknown",
            truncateToolOutput(textOfToolResult(event.result)),
            false,
          ),
        ];
      }
      case "tool_hooks": {
        // The hook's own verdict, one frame before `tool_hook_blocked`. Only a
        // block is news: an allow outcome means the call is about to run, which
        // the lifecycle frames already say.
        const outcome = asRecord(event.outcome);
        if (outcome.kind === "block" && isRefusedPlanWrite(event)) {
          return [...planWriteRow(event)];
        }
        // `ask_user_question` is settled by the `tool_hook_blocked` frame one
        // line later, which is the one carrying the user's answers; this frame
        // only says "blocked", which for a question is noise.
        if (outcome.kind !== "block" || event.toolName === ASK_USER_QUESTION) {
          return [];
        }
        return [
          ...toolRows.finished(
            event.toolCallId,
            event.toolName ?? "unknown",
            asString(outcome.text) ?? "blocked by a hook",
            true,
          ),
        ];
      }
      case "tool_hook_blocked": {
        // Either the user's decision coming back through our PreToolUse hook,
        // or the CLI's own ladder refusing outright — `shell-allow/` shows the
        // second: without `--yolo`, print mode declines a shell call the hook
        // already allowed. Both read as a failed row carrying the reason.
        //
        // A plan turn's own plan file is the exception. It carries no `--yolo`
        // precisely so that print mode refuses every write, and this one is
        // not a failure the user needs to see: the body was in the frame that
        // announced the call and the session saves the file itself.
        if (isRefusedPlanWrite(event)) {
          return [...planWriteRow(event)];
        }
        return [
          ...toolRows.finished(
            event.toolCallId,
            event.toolName ?? "unknown",
            asString(event.hookOutput) ?? "blocked by a hook",
            true,
          ),
        ];
      }
      // A delegated subagent: three frames of progress on the `task` row the
      // `agent` call opened, and the only trace of work no hook ever sees
      // (`subagents.ts`).
      case "subagent_start":
      case "subagent_progress":
      case "subagent_stop": {
        return [...toolRows.progressed(event.toolCallId, subagentProgress(event) ?? "")];
      }
      case "run_error": {
        // Held, not emitted: the `result` frame that follows says the same
        // thing in the words the user can act on. If the process dies before
        // one arrives, `onExit` reports this instead.
        heldFatal = event.error?.message ?? event.error?.name ?? "run failed";
        return [];
      }
      case "run_end": {
        const result = event.result ?? {};
        const out: Array<PendingRuntimeEvent> = [];
        // How full the context is now. The spec'd event (5.2 → the composer
        // toolbar's "Context window used") had a complete pipeline and no
        // producer: `run_end` has carried the number in every one of the 24
        // recordings and it was read by nobody.
        const used = asCompactionTokens(result.nextState);
        const limit = options.contextLimit ?? null;
        if (used !== null && limit !== null && limit > 0) {
          out.push({ type: "context.updated", payload: { used: Math.min(used, limit), limit } });
        }
        // nextState is authoritative: replay any messages the
        // streaming sources missed — dedupe makes it a no-op otherwise.
        const nextMessages = (result.nextState as { messages?: ReadonlyArray<TranscriptMessage> })
          ?.messages;
        if (Array.isArray(nextMessages)) {
          // On a resumed session the replay can carry the whole history.
          // Everything up to and including the resume marker was already
          // emitted by the previous runtime — skip it rather than dupe.
          let start = 0;
          if (resumeMarker !== null) {
            const index = nextMessages.findIndex(
              (message) => message.meta?.messageId === resumeMarker,
            );
            resumeMarker = null; // authoritative state — the marker won't appear later
            if (index !== -1) {
              start = index + 1;
            }
          }
          for (const message of nextMessages.slice(start)) {
            out.push(...processMessage(message));
          }
        }
        out.push(usageUpdated(result.usage ?? turnUsage));
        // A run that died is not settled here: the `result` line one frame
        // later words the same failure the way the user can act on it (it is
        // the one with the billing URL), and an error emitted after
        // `turn.completed` is an error row the engine cannot tag with the turn
        // — it lands outside the turn group on the timeline. `onExit` is the
        // backstop for a process that dies before that line arrives.
        if (turnOpen && !(heldFatal !== null && !reportedFatal)) {
          out.push(completeTurn(stopReasonFor(result.stopReason)));
        }
        return out;
      }
      default: {
        const streamed = deltaEvents(event, textRows, deltaRun);
        return streamed ?? [unmapped("cmd.ndjson", frame)];
      }
    }
  };

  const onTranscriptLine = (line: unknown): ReadonlyArray<PendingRuntimeEvent> => {
    if (typeof line !== "object" || line === null) {
      return [unmapped("cmd.transcript", line)];
    }
    const record = line as TranscriptLine;
    if (record.type === "session") {
      // A forked session's header keeps the id it was forked from and names
      // itself in `sessionId` (`fixtures/cmd/fork/`); read as the session's
      // own, `id` sent the next turn back to the original.
      const own = record.sessionId ?? record.id;
      if (typeof own === "string") {
        sessionId = own;
      }
      return [];
    }
    if (record.type === "message" && record.message !== undefined) {
      if (typeof record.model === "string") {
        model = record.model;
      }
      const cost = record.usage?.costUsd;
      const costKey = record.message.meta?.messageId ?? record.id;
      let priced = false;
      if (typeof cost === "number" && cost > 0 && costKey !== undefined) {
        // A resumed tailer can re-read a line it already costed; the id keeps
        // the turn's total honest.
        if (!costedLines.has(costKey)) {
          costedLines.add(costKey);
          turnCostUsd += cost;
          priced = true;
        }
      }
      // The newest message seen is the resume marker: meta.messageId when the
      // harness names it, else the transcript line's own id.
      lastMessageId = record.message.meta?.messageId ?? record.id ?? lastMessageId;
      const out = [...processMessage(record.message)];
      if (priced) {
        // The transcript is the only source of a dollar figure, and its last
        // flush lands with or after `run_end` — so the price is reported when
        // it arrives rather than only at a turn boundary that may already have
        // passed. `costedLines` is what keeps a re-read line from charging
        // twice.
        out.push(usageUpdated(turnUsage));
      }
      return out;
    }
    return [unmapped("cmd.transcript", line)];
  };

  /**
   * Settles everything the dead process left open.
   *
   * An interrupted run writes no `message_end`, no `result` and no `run_end`
   * (`fixtures/cmd/interrupt`: exit 130 after `thinking_delta` and then
   * nothing), so the rows its deltas opened kept `status: "in_progress"` — a
   * spinner under a thread that reads idle, and, because the status is what
   * goes into the event log, still spinning after a reload. A text row keeps
   * whatever it streamed; a tool call that never reported is a failure.
   */
  const settleOpenRows = (reason: string): ReadonlyArray<PendingRuntimeEvent> => {
    const out: Array<PendingRuntimeEvent> = [];
    for (const row of textRows.open()) {
      textRows.settle(row.itemId);
      out.push({
        itemId: row.itemId,
        type: "item.completed",
        payload: {
          item: {
            itemId: row.itemId,
            kind: row.kind,
            status: row.text === "" ? "failed" : "completed",
            ...(row.text === "" ? {} : { text: row.text }),
          },
        },
      });
    }
    out.push(...toolRows.abandonOpen(reason));
    return out;
  };

  const onExit = (code: number): ReadonlyArray<PendingRuntimeEvent> => {
    const out: Array<PendingRuntimeEvent> = [
      ...settleOpenRows(
        code === 130
          ? "the turn was interrupted before this call finished"
          : "the harness exited before this call finished",
      ),
    ];

    // A clean exit means the harness recovered from whatever it held — there is
    // nothing for the user to do about a request that was retried and worked.
    if (code === 0) {
      heldFatal = null;
    }
    const named = EXIT_MESSAGES[code];
    if (heldFatal !== null) {
      out.push(...fatalError(heldFatal));
    } else if (named !== undefined) {
      // A non-fatal code plants no row, only a status — so it is always worth
      // saying, even after a fatal error has been reported.
      out.push(
        ...(named.fatal
          ? fatalError(named.message)
          : [{ type: "runtime.error" as const, payload: { ...named } }]),
      );
    } else if (code !== 0 && code !== 130) {
      out.push(...fatalError(`cmd exited with code ${code}`));
    }
    if (turnOpen) {
      out.push(
        completeTurn(
          code === 130
            ? "interrupted"
            : code === 8
              ? "max_turns"
              : code === 0
                ? "end_turn"
                : "error",
        ),
      );
    }
    return out;
  };

  return {
    onFrame,
    onTranscriptLine,
    onExit,
    get sessionId() {
      return sessionId;
    },
    get lastMessageId() {
      return lastMessageId;
    },
  };
};
