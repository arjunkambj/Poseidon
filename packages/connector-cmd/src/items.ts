/**
 * Command Code's tool vocabulary and the timeline rows it produces.
 *
 * Two things live here, both of which the translator would otherwise carry on
 * top of its own job.
 *
 * The first is the shape of what the harness says: the transcript's message and
 * block types, the tool-name → `ItemKind` table, and the small readers
 * that turn an unknown into something worth putting on a row.
 *
 * The second is `makeToolRows`, which owns a session's tool calls. One call
 * arrives up to five times — `tool_queued` with its input, `tool_running` with
 * neither, maybe `tool_update`, then `tool_completed` or a refusal, and finally
 * the transcript's own `tool_use`/`tool_result` pair one model round trip later
 * — and every one of them has to land on the row the first sighting opened.
 * `toolCallId` is the key that makes that work, and it is the same id in the
 * frames and in the transcript.
 */

import * as NodeCrypto from "node:crypto";
import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import { makeItemId } from "@poseidon/contracts/ids";
import type { ItemSnapshot, RuntimeEvent, Todo } from "@poseidon/contracts/runtime";

import type { CmdUsage } from "./ndjson";
import { isPlanWrite, PLAN_SAVED } from "./plans";
import { readableAnswers } from "./questions";

/** The tool the question bridge answers by denying it — see `readableAnswers`. */
export const ASK_USER_QUESTION = "ask_user_question";

/**
 * How a finished call reads. Two tools' refusals are successes: an answered
 * `ask_user_question`, where the bridge denies on purpose and hands the user's
 * answers back as the reason, and a plan turn's own plan file, which print
 * mode refuses because a plan turn is spawned without `--yolo`.
 */
const settlement = (
  tool: { readonly name?: string; readonly input?: unknown } | undefined,
  output: string,
  failed: boolean,
): { readonly output: string; readonly failed: boolean } => {
  if (tool?.name === ASK_USER_QUESTION) {
    return { output: readableAnswers(output), failed: false };
  }
  // The plan a plan turn wrote. Plan turns carry no `--yolo`, so print mode
  // refuses this write like any other — and that refusal is what makes the
  // mode read-only, not a failure the reader needs to see. The body was in
  // the frame that announced the call and the session saves it (`plans.ts`).
  if (isPlanWrite(tool?.name, tool?.input)) {
    return { output: PLAN_SAVED, failed: false };
  }
  return { output, failed };
};

/**
 * A `RuntimeEvent` minus the envelope fields the session stamps on the way
 * out — the same shape testkit's `ScriptedRuntimeEvent` uses.
 */
type WithoutEnvelope<Event> = Event extends RuntimeEvent
  ? Omit<Event, "eventId" | "connectorInstanceId" | "threadId" | "createdAt">
  : never;

export type PendingRuntimeEvent = WithoutEnvelope<RuntimeEvent>;

// ── transcript shapes (only what we read) ─────────────────────

export interface TranscriptMeta {
  readonly source?: string;
  readonly createdAt?: number;
  readonly messageId?: string;
}

export interface TranscriptMessage {
  readonly role?: string;
  readonly content?: ReadonlyArray<unknown>;
  readonly meta?: TranscriptMeta;
}

export interface TranscriptLine {
  readonly type?: string;
  readonly id?: string;
  /** On a forked session's header only: the new session; `id` is the one it came from. */
  readonly sessionId?: string;
  readonly parentId?: string;
  readonly timestamp?: string;
  readonly message?: TranscriptMessage;
  readonly usage?: CmdUsage & { readonly costUsd?: number };
  readonly model?: string;
}

export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

// ── tool vocabulary ───────────────────────────────────────────

const TOOL_KIND: Readonly<Record<string, ItemKind>> = {
  shell_command: "command_execution",
  edit_file: "file_change",
  write_file: "file_change",
  read_file: "tool_call",
  read_directory: "tool_call",
  glob: "tool_call",
  grep: "tool_call",
  todo_write: "todo",
  agent: "task",
  activate_skill: "skill",
  web_search: "web_search",
  web_fetch: "web_search",
};

export const kindForTool = (name: string): ItemKind =>
  name.startsWith("mcp__") ? "mcp_tool_call" : (TOOL_KIND[name] ?? "tool_call");

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Nothing worth showing: `undefined`, `null`, or `{}`. */
export const isEmptyInput = (value: unknown): boolean =>
  value === undefined || value === null || Object.keys(asRecord(value)).length === 0;

/** The harness writes `description: null`, which is not the same as absent. */
export const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * A stable key for a message with no `meta.messageId`. The old
 * `anon:<blockIndex>` scheme collapsed every anonymous message's block N onto
 * one itemId and gave anonymous tool_use a fresh key per sighting; hashing
 * role+content dedupes the same message re-seen (tailer then run_end) while
 * keeping different messages apart.
 */
export const anonymousKey = (message: TranscriptMessage): string =>
  `anon:${NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ role: message.role, content: message.content }), "utf8")
    .digest("hex")
    .slice(0, 16)}`;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * `nextState.modState.compaction.tokens` — how many tokens the conversation
 * occupies after this run. The only place the harness reports it.
 */
export const asCompactionTokens = (nextState: unknown): number | null => {
  const tokens = asRecord(asRecord(asRecord(nextState).modState).compaction).tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
    ? Math.trunc(tokens)
    : null;
};

/** `mcp__<server>__<tool>` → server; undefined for ordinary tools. */
export const mcpServerOf = (name: string): string | undefined => {
  if (!name.startsWith("mcp__")) {
    return undefined;
  }
  const rest = name.slice(5);
  const separator = rest.indexOf("__");
  return separator === -1 ? rest : rest.slice(0, separator);
};

export const textOfToolResult = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => asString(asRecord(block).text))
      .filter((text): text is string => text !== undefined)
      .join("\n");
  }
  return "";
};

/**
 * Tool results land whole in item snapshots — a build log or a minified file
 * would otherwise inflate the event log and the stream budget. 64KB keeps a
 * useful head and marks the cut.
 */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

export const truncateToolOutput = (text: string): string =>
  text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}...[truncated]`
    : text;

export const todosOf = (input: Record<string, unknown>): ReadonlyArray<Todo> =>
  (Array.isArray(input.todos) ? input.todos : []).flatMap((todo, index) => {
    const record = asRecord(todo);
    const text = asString(record.text) ?? asString(record.content) ?? asString(record.title);
    if (text === undefined || text === "") {
      return [];
    }
    const status = asString(record.status);
    return [
      {
        todoId: asString(record.id) ?? asString(record.todoId) ?? `todo-${index}`,
        text,
        status: status === "in_progress" || status === "completed" ? status : ("pending" as const),
      } satisfies Todo,
    ];
  });

// ── a session's tool rows ──────────────────────────────────────

export interface ToolRows {
  /** A `tool_queued`/`tool_running`/`tool_use` sighting → started or updated. */
  readonly started: (
    toolUseId: string | undefined,
    toolName: string,
    input: unknown,
    description?: string,
    fallbackKey?: string,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** A `tool_completed` or a refusal → the row is done, well or badly. */
  readonly finished: (
    toolCallId: string | undefined,
    toolName: string,
    output: string,
    failed: boolean,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** The transcript's `tool_result` block → the same completion, later. */
  readonly completed: (block: ToolResultBlock) => ReadonlyArray<PendingRuntimeEvent>;
  /** `tool_update`: a long-running tool's output so far. */
  readonly progressed: (
    toolCallId: string | undefined,
    partial: string,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** The input a `tool_queued` announced the call with, if one did. */
  readonly inputFor: (toolCallId: string | undefined) => unknown;
  /**
   * Fails every row still running and says why. A SIGINT'd run writes no
   * `tool_completed`, no `message_end` and no `run_end`, so a call that was
   * queued when the user pressed Stop otherwise span under an idle thread for
   * as long as the thread existed — the wrong status goes into the event log,
   * so it survives a reload too.
   */
  readonly abandonOpen: (reason: string) => ReadonlyArray<PendingRuntimeEvent>;
}

export const makeToolRows = (): ToolRows => {
  const toolItems = new Map<string, ItemId>();
  /** tool_use.id → the last snapshot emitted for it, for result merging. */
  const toolSnapshots = new Map<string, ItemSnapshot>();
  /**
   * tool_use.id → the input the call was announced with. `tool_queued` carries
   * it; `tool_running` and `tool_completed` do not (`description` is null in
   * every recording), so without this a later frame would rebuild the row from
   * `{}` and wipe the command it is showing.
   */
  const toolInputs = new Map<string, unknown>();
  const snapshotForTool = (
    itemId: ItemId,
    toolName: string,
    input: unknown,
    description?: string,
  ): ItemSnapshot => {
    const record = asRecord(input);
    const kind = kindForTool(toolName);
    const base: ItemSnapshot = {
      itemId,
      kind,
      status: "in_progress",
      ...(description === undefined ? {} : { text: description }),
    };
    switch (kind) {
      case "command_execution": {
        const cmd = asString(record.command) ?? description ?? toolName;
        return {
          ...base,
          command: {
            cmd,
            ...(asString(record.cwd) === undefined ? {} : { cwd: asString(record.cwd) }),
          },
        };
      }
      case "file_change": {
        const path = asString(record.file_path) ?? asString(record.path) ?? toolName;
        return {
          ...base,
          fileChange: {
            path,
            kind: toolName === "write_file" ? "create" : "edit",
          },
          tool: { name: toolName, input },
        };
      }
      case "todo": {
        return { ...base, todos: [...todosOf(record)] };
      }
      case "mcp_tool_call": {
        const server = mcpServerOf(toolName);
        return {
          ...base,
          tool: { name: toolName, ...(server === undefined ? {} : { server }), input },
        };
      }
      default: {
        return { ...base, tool: { name: toolName, input } };
      }
    }
  };

  /** A tool_use block/frame → item.started (first sight) or item.updated (known id). */
  const toolStarted = (
    toolUseId: string | undefined,
    toolName: string,
    input: unknown,
    description?: string,
    fallbackKey?: string,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    // No tool_use.id: the containing message's dedupe key + block index is a
    // stable fallback — a key minted per sighting duplicated the row on replay.
    const key = toolUseId ?? fallbackKey ?? `anon:${toolName}:${makeItemId()}`;
    // `tool_running` and `tool_completed` announce no input; the one
    // `tool_queued` carried is the row's, and an empty object must never
    // replace it.
    const known = toolInputs.get(key);
    const effective = isEmptyInput(input) && known !== undefined ? known : input;
    if (!isEmptyInput(effective)) {
      toolInputs.set(key, effective);
    }
    const existing = toolItems.get(key);
    if (existing !== undefined) {
      const prior = toolSnapshots.get(key);
      const next = snapshotForTool(existing, toolName, effective, description);
      // Never regress a finished row back to in_progress on a late duplicate.
      const snapshot = prior === undefined ? next : { ...prior, ...next, status: prior.status };
      toolSnapshots.set(key, snapshot);
      return [{ itemId: existing, type: "item.updated", payload: { item: snapshot } }];
    }
    const itemId = makeItemId();
    toolItems.set(key, itemId);
    const snapshot = snapshotForTool(itemId, toolName, effective, description);
    toolSnapshots.set(key, snapshot);
    return [{ itemId, type: "item.started", payload: { item: snapshot } }];
  };

  /**
   * A `tool_completed` / `tool_hook_blocked` frame → `item.completed` on the row
   * its `tool_queued` opened. Same shape as the transcript's `tool_result`, but
   * arriving one model round trip earlier, so this is what settles the row on
   * screen.
   */
  const toolFinished = (
    toolCallId: string | undefined,
    toolName: string,
    rawOutput: string,
    rawFailed: boolean,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    const key = toolCallId ?? `anon:${toolName}:${makeItemId()}`;
    const { output, failed } = settlement(
      { name: toolName, input: toolInputs.get(key) },
      rawOutput,
      rawFailed,
    );
    const existing = toolItems.get(key);
    const itemId = existing ?? makeItemId();
    const prior =
      toolSnapshots.get(key) ??
      snapshotForTool(itemId, toolName, toolInputs.get(key) ?? {}, undefined);
    const snapshot: ItemSnapshot = {
      ...prior,
      itemId,
      status: failed ? "failed" : "completed",
      ...(prior.command === undefined ? {} : { command: { ...prior.command, output } }),
      ...(prior.tool === undefined ? {} : { tool: { ...prior.tool, output } }),
      ...(failed ? { error: { message: output } } : {}),
    };
    toolItems.set(key, itemId);
    toolSnapshots.set(key, snapshot);
    return [{ itemId, type: "item.completed", payload: { item: snapshot } }];
  };

  /** A tool_result block → item.completed on the row the tool_use opened. */
  const toolCompleted = (block: ToolResultBlock): ReadonlyArray<PendingRuntimeEvent> => {
    const existing = block.tool_use_id === undefined ? undefined : toolItems.get(block.tool_use_id);
    const itemId = existing ?? makeItemId();
    const prior = existing === undefined ? undefined : toolSnapshots.get(block.tool_use_id!);
    // The transcript replays the deny the bridge answered with, so the same
    // reading applies here as on the frame that settled the row live.
    const text = truncateToolOutput(
      settlement(prior?.tool, textOfToolResult(block.content), false).output,
    );
    // A call a hook blocked still gets a `tool_result` in the transcript — the
    // refusal is what the model is told — and it carries no `is_error`. The
    // frames are the authority on whether the call ran, so a row already marked
    // failed is never talked back into "completed" — except for the two tools
    // whose refusal is a success, which `settlement` names.
    const settled = settlement(
      prior?.tool,
      "",
      prior?.status === "failed" || block.is_error === true,
    );
    const status = settled.failed ? ("failed" as const) : ("completed" as const);
    const snapshot: ItemSnapshot =
      prior !== undefined
        ? {
            ...prior,
            status,
            ...(prior.command !== undefined ? { command: { ...prior.command, output: text } } : {}),
            ...(prior.tool !== undefined ? { tool: { ...prior.tool, output: text } } : {}),
            ...(block.is_error === true ? { error: { message: text } } : {}),
          }
        : {
            itemId,
            kind: "tool_call",
            status,
            tool: { name: "tool", input: {}, output: text },
            ...(block.is_error === true ? { error: { message: text } } : {}),
          };
    if (block.tool_use_id !== undefined) {
      toolItems.set(block.tool_use_id, itemId);
      toolSnapshots.set(block.tool_use_id, snapshot);
    }
    return [{ itemId, type: "item.completed", payload: { item: snapshot } }];
  };

  const progressed = (
    toolCallId: string | undefined,
    partial: string,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    const itemId = toolCallId === undefined ? undefined : toolItems.get(toolCallId);
    const prior = toolCallId === undefined ? undefined : toolSnapshots.get(toolCallId);
    if (toolCallId === undefined || itemId === undefined || prior === undefined || partial === "") {
      return [];
    }
    const output = truncateToolOutput(partial);
    const snapshot: ItemSnapshot = {
      ...prior,
      ...(prior.command === undefined ? {} : { command: { ...prior.command, output } }),
      ...(prior.tool === undefined ? {} : { tool: { ...prior.tool, output } }),
    };
    toolSnapshots.set(toolCallId, snapshot);
    return [{ itemId, type: "item.updated", payload: { item: snapshot } }];
  };

  const abandonOpen = (reason: string): ReadonlyArray<PendingRuntimeEvent> => {
    const out: Array<PendingRuntimeEvent> = [];
    for (const [key, prior] of toolSnapshots) {
      if (prior.status !== "in_progress") {
        continue;
      }
      const snapshot: ItemSnapshot = { ...prior, status: "failed", error: { message: reason } };
      toolSnapshots.set(key, snapshot);
      out.push({ itemId: prior.itemId, type: "item.completed", payload: { item: snapshot } });
    }
    return out;
  };

  return {
    inputFor: (toolCallId) => (toolCallId === undefined ? undefined : toolInputs.get(toolCallId)),
    started: toolStarted,
    finished: toolFinished,
    completed: toolCompleted,
    progressed,
    abandonOpen,
  };
};
