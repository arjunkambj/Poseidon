/**
 * SDK messages → `RuntimeEvent`s, one session's worth.
 *
 * One translator lives as long as its session, because what it has to
 * remember crosses messages: which stream rows a snapshot finishes
 * (`textRows.ts`), the model the CLI reported, how full the context was after
 * the last request, and the running cost total a result is measured against.
 *
 * What it maps:
 *
 * - `stream_event` text and thinking deltas → `content.delta` on rows the
 *   block starts open. A row still open when the turn's `result` arrives is
 *   completed there, with the text its deltas grew;
 * - `assistant` snapshots → the finished `assistant_message` and `reasoning`
 *   rows. A snapshot the CLI wrote in place of an answer because the request
 *   failed — it carries `error`, and the text is the CLI's own line, such as
 *   "Not logged in · Please run /login" — becomes a `runtime.error` instead,
 *   fatal and naming the login command when the failure is the sign-in;
 * - the `tool_use` blocks of those snapshots, and the `tool_result`s the CLI
 *   writes back as `user` messages → one row per call (`tools.ts`), opened by
 *   the call and settled by its result. Rows a turn leaves open when its
 *   `result` arrives are failed there, so none spins under an idle thread;
 * - `system/init` → `mcp.status.updated`, and the model it reports is kept for
 *   the context window. It is not reported as `model.changed`: the CLI names
 *   the model a choice resolved to (`default` runs as a dated id), and the
 *   thread keeps the id the user picked;
 * - `result` → `usage.updated`, `context.updated` and `turn.completed`
 *   (`result.ts`);
 * - a Task or Agent call → a `task` row and `task.started`, the `task_*`
 *   system messages → `task.updated` and `task.completed`, and every message
 *   a subagent sends (`parent_tool_use_id`) → rows nested under that task
 *   (`subagents.ts`). A subagent's messages are read as the main loop's are,
 *   but they never move the session's context, cost or rewind point: those
 *   are the main conversation's. The user message a subagent is handed is the
 *   call's own prompt, already on the task's row, and adds nothing;
 * - `system/status: compacting` and `system/compact_boundary` → one
 *   `context_compaction` row, opened and settled, and the context left after
 *   it (`compaction.ts`);
 * - a `system/status` that only reports the CLI's permission mode → nothing;
 *   the session reads the mode off it (`isModeReport`). A status of `null`
 *   after `compacting` is the CLI going back to work: nothing more when the
 *   boundary settled the compaction, its row failed when the CLI says the
 *   compaction failed;
 * - `command_lifecycle` and `system/status: requesting` → nothing, on purpose.
 *   The first is the CLI's receipt for each user message the session wrote
 *   (queued, started, then how it ended); the session reads it for itself, to
 *   tell when a steered message has been taken up (`steering.ts`), and the
 *   thread already has the message. The second says a request is on its way
 *   to the API, which the deltas that follow say again.
 *
 * Everything else — a user message that is not tool results, status and
 * lifecycle notices, a task nothing here has heard of — is kept whole as
 * `event.unmapped` until a mapping exists for it. Nothing is dropped silently;
 * the stream events skipped here are the block boundaries and message-level
 * bookkeeping the snapshot restates.
 */

import type { ItemId } from "@poseidon/contracts/ids";
import type { McpServerStatus } from "@poseidon/contracts/runtime";

import {
  asArray,
  asNumber,
  asRecord,
  asString,
  tokens,
  unmapped,
  type Json,
  type PendingRuntimeEvent,
} from "./pending";
import { makeCompaction } from "./compaction";
import { resultEvents, type TurnContext } from "./result";
import { makeSubagents } from "./subagents";
import { makeTextRows } from "./textRows";
import { makeToolRows } from "./tools";

export type { TurnContext };

/** Stream events that carry nothing the snapshot will not restate. */
const RESTATED_STREAM_EVENTS = new Set([
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
]);

/** `system/status` values that only say a request is under way. */
const REQUEST_STATUSES = new Set(["requesting"]);

/** The `task_*` system messages: a subagent's, or a background command's, lifecycle. */
const TASK_MESSAGES = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
]);

/** The key the main loop's stream is kept under; a subagent's is its call's id. */
const MAIN_LOOP = "";

/**
 * A `system/status` with no status but a `permissionMode`: the CLI saying
 * which permission mode it is in now. The session keeps that for itself
 * (`session.ts`); the thread's modes are Poseidon's, so nothing is shown.
 */
export const isModeReport = (message: Json): boolean =>
  (message.status === null || message.status === undefined) &&
  asString(message.permissionMode) !== undefined;

/** How the CLI's MCP server states read in the contract's vocabulary. */
const MCP_STATUS: Readonly<Record<string, McpServerStatus>> = {
  connected: "connected",
  pending: "connecting",
  failed: "failed",
  "needs-auth": "failed",
  disabled: "disabled",
};

export interface Translator {
  readonly translate: (
    message: unknown,
    turn: TurnContext | null,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** The newest main-loop assistant message, a point `resumeSessionAt` can rewind to. */
  readonly lastAssistantUuid: () => string | undefined;
  /** The newest `total_cost_usd`, for the session ref. */
  readonly totalCost: () => number | null;
  /** How many tool calls have run to a result that is not an error, so far. */
  readonly toolCallsRan: () => number;
  /** The plan an ExitPlanMode call handed over, settled on its row. */
  readonly planProposed: (
    toolUseId: string | undefined,
    markdown: string,
  ) => ReadonlyArray<PendingRuntimeEvent>;
}

/** Why a tool row still open at the end of its turn is failed. */
export const TURN_ENDED_UNDER_TOOL = "The turn ended before this tool call finished.";

export const makeTranslator = (options: {
  /** What the user types to sign the CLI in — named when a request fails on it. */
  readonly loginCommand: string;
  /** 0 for a fresh session, the ref's saved total for a resumed one. */
  readonly previousTotalCost: number | null;
}): Translator => {
  const rows = makeTextRows();
  const tools = makeToolRows();
  const subagents = makeSubagents();
  const compaction = makeCompaction();
  /** The message each stream is in the middle of: the main loop's, and each subagent's. */
  const streamMessages = new Map<string, string>();
  /** Every row a subagent opened → the task row it is nested under. */
  const nestedUnder = new Map<ItemId, ItemId>();
  let model: string | null = null;
  let contextUsed: number | null = null;
  let contextLimit: number | null = null;
  let totalCost = options.previousTotalCost;
  let errorReported = false;
  let lastAssistantUuid: string | undefined;

  const streamEvent = (message: Json, stream: string): ReadonlyArray<PendingRuntimeEvent> => {
    const event = asRecord(message.event);
    const type = asString(event.type);
    const index = asNumber(event.index) ?? 0;
    const current = streamMessages.get(stream);
    switch (type) {
      case "message_start": {
        const id = asString(asRecord(event.message).id);
        if (id === undefined) streamMessages.delete(stream);
        else streamMessages.set(stream, id);
        return [];
      }
      case "content_block_start": {
        const block = asString(asRecord(event.content_block).type);
        if (current === undefined) return [];
        if (block === "text") return rows.open(current, index, "assistant_message");
        if (block === "thinking") return rows.open(current, index, "reasoning");
        // Tool-use and other blocks are told by the snapshot that follows.
        return [];
      }
      case "content_block_delta": {
        const delta = asRecord(event.delta);
        if (current === undefined) return [];
        if (delta.type === "text_delta") {
          return rows.delta(current, index, asString(delta.text) ?? "");
        }
        if (delta.type === "thinking_delta") {
          return rows.delta(current, index, asString(delta.thinking) ?? "");
        }
        // Tool input and thinking signatures arrive whole in the snapshot.
        return [];
      }
      default:
        return type !== undefined && RESTATED_STREAM_EVENTS.has(type) ? [] : [unmapped(message)];
    }
  };

  const failedRequest = (message: Json, error: string): ReadonlyArray<PendingRuntimeEvent> => {
    errorReported = true;
    const said = asArray(asRecord(message.message).content)
      .flatMap((block) => {
        const text = asString(asRecord(block).text);
        return text === undefined ? [] : [text];
      })
      .join("\n")
      .trim();
    const text =
      error === "authentication_failed"
        ? `Claude Code is not signed in. Run \`${options.loginCommand}\` in a terminal, then send the message again.`
        : said === ""
          ? `Claude Code request failed: ${error}`
          : said;
    // Signed out is fatal, as Command Code's exit 3 is: nothing the thread
    // sends will work until the user signs in, and only a fatal error is a
    // row on the timeline. A failed request is the turn failing, and the next
    // message may well work.
    return [
      {
        type: "runtime.error",
        payload: { message: text, fatal: error === "authentication_failed" },
      },
    ];
  };

  /**
   * The rows of one snapshot's blocks: text and thinking settle, each call
   * opens its row, and a Task or Agent call starts its task too. `parent` is
   * the task a subagent's snapshot belongs to.
   */
  const snapshotRows = (message: Json, parent: ItemId | undefined) => {
    const body = asRecord(message.message);
    const messageId = asString(body.id) ?? asString(message.uuid) ?? "";
    const events: Array<PendingRuntimeEvent> = [];
    let untold = false;
    for (const entry of asArray(body.content)) {
      const block = asRecord(entry);
      if (block.type === "text") {
        events.push(...rows.settle(messageId, "assistant_message", asString(block.text) ?? ""));
      } else if (block.type === "thinking") {
        // Settled even when empty, so the row its stream opened completes.
        events.push(...rows.settle(messageId, "reasoning", asString(block.thinking) ?? ""));
      } else if (block.type === "tool_use") {
        events.push(...tools.started(block));
        const id = asString(block.id);
        const row = id === undefined ? undefined : tools.rowOf(id);
        if (id !== undefined && row?.kind === "task") {
          events.push(...subagents.opened(id, row.itemId, asRecord(block.input), parent));
        }
      } else {
        untold = true;
      }
    }
    return { events, untold };
  };

  const assistant = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const error = asString(message.error);
    if (error !== undefined) return failedRequest(message, error);
    lastAssistantUuid = asString(message.uuid) ?? lastAssistantUuid;
    const body = asRecord(message.message);
    const reported = asRecord(message.context_usage);
    const usage = asRecord(body.usage);
    const used =
      asNumber(reported.total_tokens) ??
      tokens(usage.input_tokens) +
        tokens(usage.cache_read_input_tokens) +
        tokens(usage.cache_creation_input_tokens) +
        tokens(usage.output_tokens);
    if (used > 0) contextUsed = used;
    const limit = asNumber(reported.raw_max_tokens);
    if (limit !== undefined && limit > 0) contextLimit = limit;
    const { events, untold } = snapshotRows(message, undefined);
    return untold ? [...events, unmapped(message)] : events;
  };

  /**
   * A user message the CLI wrote: the results of the calls the model made.
   * `tool_use_result` is the tool's structured output, and belongs to the
   * message's one result — a message carrying several is read without it.
   */
  const user = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const blocks = asArray(asRecord(message.message).content).map(asRecord);
    const results = blocks.filter((block) => block.type === "tool_result");
    if (results.length === 0 || results.length !== blocks.length) return [unmapped(message)];
    const structured = results.length === 1 ? message.tool_use_result : undefined;
    return results.flatMap((block) => tools.finished(block, structured));
  };

  /** A subagent's message, read as the main loop's but moving none of its state. */
  const subagentMessage = (
    message: Json,
    stream: string,
    parent: ItemId | undefined,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    switch (message.type) {
      case "stream_event":
        return streamEvent(message, stream);
      case "assistant": {
        // A subagent's failed request is its own text, and its task's result.
        const { events, untold } = snapshotRows(message, parent);
        return untold ? [...events, unmapped(message)] : events;
      }
      case "user": {
        const content = asRecord(message.message).content;
        const blocks = asArray(content).map(asRecord);
        const prompt =
          typeof content === "string" ||
          (blocks.length > 0 && blocks.every((block) => block.type === "text"));
        return prompt ? [] : user(message);
      }
      default:
        return [unmapped(message)];
    }
  };

  /** Nests every row in `events` under `parent`, and remembers it for later snapshots. */
  const nest = (
    events: ReadonlyArray<PendingRuntimeEvent>,
    parent: ItemId,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    for (const event of events) {
      if (event.type === "item.started" || event.type === "item.completed") {
        if (event.payload.item.itemId !== parent) {
          nestedUnder.set(event.payload.item.itemId, parent);
        }
      }
    }
    return withParents(events);
  };

  /**
   * Every row a subagent opened carries its task, whichever path settles it —
   * the subagent's own result, a plan, or the turn failing what is still open.
   */
  const withParents = (
    events: ReadonlyArray<PendingRuntimeEvent>,
  ): ReadonlyArray<PendingRuntimeEvent> =>
    nestedUnder.size === 0
      ? events
      : events.map((event) => {
          if (event.type !== "item.started" && event.type !== "item.completed") return event;
          const item = event.payload.item;
          const parent = nestedUnder.get(item.itemId);
          if (parent === undefined || item.parentItemId !== undefined) return event;
          return {
            ...event,
            payload: { ...event.payload, item: { ...item, parentItemId: parent } },
          };
        });

  /** A message from inside a subagent: nested, or held until its task's row opens. */
  const fromSubagent = (message: Json, toolUseId: string): ReadonlyArray<PendingRuntimeEvent> => {
    const row = tools.rowOf(toolUseId);
    if (row === undefined) {
      subagents.hold(toolUseId, message);
      return [];
    }
    return nest(subagentMessage(message, toolUseId, row.itemId), row.itemId);
  };

  /** A `task_*` message's task events, or the message kept unmapped when it is not a task's. */
  const lifecycleOf = (toolUseId: string, message: Json): ReadonlyArray<PendingRuntimeEvent> =>
    subagents.lifecycle(toolUseId, message) ?? [unmapped(message)];

  /** A `task_*` system message: its task's events, held while the call has no row. */
  const taskMessage = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const toolUseId = subagents.callOf(message);
    if (toolUseId === undefined) return [unmapped(message)];
    if (tools.rowOf(toolUseId) === undefined) {
      subagents.hold(toolUseId, message);
      return [];
    }
    return lifecycleOf(toolUseId, message);
  };

  /** The held messages whose task row has opened since, read now. */
  const released = (): ReadonlyArray<PendingRuntimeEvent> =>
    subagents
      .takeReady(tools.rowOf)
      .flatMap(({ toolUseId, message }) =>
        message.type === "system"
          ? lifecycleOf(toolUseId, message)
          : fromSubagent(message, toolUseId),
      );

  /**
   * The turn ended with messages still held: their task never opened a row.
   * A subagent's rows are shown unnested; a lifecycle message with no row to
   * move is kept unmapped.
   */
  const orphans = (): ReadonlyArray<PendingRuntimeEvent> =>
    subagents
      .takeAll()
      .flatMap((message) =>
        message.type === "system"
          ? [unmapped(message)]
          : subagentMessage(message, asString(message.parent_tool_use_id) ?? MAIN_LOOP, undefined),
      );

  const init = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    model = asString(message.model) ?? model;
    const servers = asArray(message.mcp_servers).flatMap((entry) => {
      const server = asRecord(entry);
      const name = asString(server.name);
      if (name === undefined || name === "") return [];
      return [{ name, status: MCP_STATUS[asString(server.status) ?? ""] ?? "failed" }];
    });
    return [{ type: "mcp.status.updated", payload: { servers } }];
  };

  const system = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const subtype = asString(message.subtype) ?? "";
    if (subtype === "init") return init(message);
    if (TASK_MESSAGES.has(subtype)) return taskMessage(message);
    if (subtype === "compact_boundary") {
      const { events, contextUsed: used } = compaction.boundary(message, contextLimit);
      if (used !== undefined) contextUsed = used;
      return events;
    }
    if (subtype === "status") {
      const status = message.status;
      if (status === "compacting") return compaction.compacting();
      if (REQUEST_STATUSES.has(asString(status) ?? "")) return [];
      if (isModeReport(message)) return [];
      if (status === null) return compaction.statusCleared(message);
    }
    return [unmapped(message)];
  };

  const mainLoop = (
    message: Json,
    turn: TurnContext | null,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    switch (message.type) {
      case "stream_event":
        return streamEvent(message, MAIN_LOOP);
      case "assistant":
        return assistant(message);
      case "user":
        return user(message);
      case "system":
        return system(message);
      case "command_lifecycle":
        return [];
      case "result": {
        const { events, totalCost: total } = resultEvents(message, turn, {
          previousTotalCost: totalCost,
          contextUsed,
          contextLimit,
          model,
          errorReported,
        });
        if (total !== null) totalCost = total;
        errorReported = false;
        return [
          ...orphans(),
          ...compaction.abandon(),
          ...tools.abandonOpen(TURN_ENDED_UNDER_TOOL),
          ...rows.closeOpen(),
          ...events,
        ];
      }
      default:
        return [unmapped(message)];
    }
  };

  const translate = (
    raw: unknown,
    turn: TurnContext | null,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    const message = asRecord(raw);
    const parent = asString(message.parent_tool_use_id);
    const events =
      parent !== undefined && message.type !== "system" && message.type !== "result"
        ? fromSubagent(message, parent)
        : mainLoop(message, turn);
    return withParents([...events, ...released()]);
  };

  return {
    translate,
    lastAssistantUuid: () => lastAssistantUuid,
    totalCost: () => totalCost,
    toolCallsRan: tools.ran,
    planProposed: (toolUseId, markdown) => withParents(tools.planProposed(toolUseId, markdown)),
  };
};
