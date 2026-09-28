/**
 * App-server notifications → `RuntimeEvent`s, one session's worth.
 *
 * One translator lives as long as its session, because what it remembers
 * crosses notifications: the rows items opened (`tools.ts`), the thread's
 * token total (`usage.ts`), the turn's checklist row, and the state of every
 * MCP server the thread started.
 *
 * What it maps:
 *
 * - `item/started`, `item/completed` and the item deltas
 *   (`item/agentMessage/delta`, `item/reasoning/summaryTextDelta` and
 *   `textDelta`, `item/plan/delta`, `item/commandExecution/outputDelta`,
 *   `item/fileChange/patchUpdated`) → rows (`tools.ts`);
 * - `turn/plan/updated` → one `todo` row per turn, the model's checklist;
 * - `thread/tokenUsage/updated` → `usage.updated` and `context.updated`;
 * - `turn/completed` → the rows the turn left open failed, the checklist
 *   settled, the turn's error when nothing said it yet, and `turn.completed`:
 *   `completed` is `end_turn`, `interrupted` is `interrupted`, `failed` is
 *   `error`. A turn the user stopped reads `interrupted` whatever it says;
 * - `error` → `runtime.error`, fatal when the server says the request was
 *   unauthorized — the account needs signing in again, and the message names
 *   the login command. An error the server is about to retry is only a
 *   `session.warning`;
 * - `warning`, `configWarning`, `guardianWarning`, `deprecationNotice` and
 *   `model/rerouted` → `session.warning`;
 * - `mcpServer/startupStatus/updated` → `mcp.status.updated`, every server
 *   the thread started with its latest state.
 *
 * `IGNORED` lists what carries nothing the timeline shows, each with why.
 * Everything else is kept whole as `event.unmapped` until a mapping exists
 * for it, so a protocol change shows up instead of going quietly missing.
 */

import type { TurnId } from "@poseidon/contracts/ids";
import { makeItemId, type ItemId } from "@poseidon/contracts/ids";
import type { McpServerStatus, Todo } from "@poseidon/contracts/runtime";

import {
  asArray,
  asRecord,
  asString,
  nonEmpty,
  unmapped,
  type Json,
  type Notification,
  type PendingRuntimeEvent,
} from "./pending";
import { makeItemRows } from "./tools";
import { makeUsageTracker } from "./usage";

/** The turn a notification belongs to, as the session knows it. */
export interface TurnContext {
  readonly turnId: TurnId;
  /** The user pressed stop: the completion reads `interrupted`, whatever it says. */
  readonly interrupted: boolean;
}

/**
 * Notifications that carry nothing Poseidon shows, and why each is safe to
 * drop. A method listed here never becomes `event.unmapped`.
 */
export const IGNORED: Readonly<Record<string, string>> = {
  "thread/started": "the thread/start or thread/resume response already said it",
  "thread/status/changed": "idle/active restates turn/started and turn/completed",
  "turn/started": "the session opened the turn when it sent turn/start",
  "turn/diff/updated": "the turn's whole diff; Poseidon reads diffs from git",
  "thread/goal/cleared": "the CLI's own goal feature, which Poseidon does not drive",
  "thread/goal/updated": "the CLI's own goal feature, which Poseidon does not drive",
  "thread/name/updated": "the CLI's thread title; Poseidon names its own threads",
  "thread/settings/updated": "a restatement of settings the session itself sent",
  "thread/compacted": "deprecated twin of the contextCompaction item, which is mapped",
  "account/updated": "the account's plan; the probe reads the account",
  "account/rateLimits/updated": "rate-limit headroom; nothing in Poseidon shows it yet",
  "remoteControl/status/changed": "the CLI's remote control, which Poseidon does not use",
  "skills/changed": "the skill list changed on disk; nothing here lists skills",
  "serverRequest/resolved": "a server request was answered; the session answered it",
  "item/reasoning/summaryPartAdded":
    "a boundary inside a reasoning summary; the deltas carry the text",
  "item/fileChange/outputDelta":
    "deprecated patch output; patchUpdated and the item carry the diff",
  "item/commandExecution/terminalInteraction": "stdin written to a command's terminal",
  "item/mcpToolCall/progress": "an MCP tool's progress note; the call's row settles on completion",
  "hook/started": "the CLI's own hooks; Poseidon does not install any",
  "hook/completed": "the CLI's own hooks; Poseidon does not install any",
  "rawResponseItem/completed": "the raw model response the items already carry",
  "rawResponse/completed": "the raw model response the items already carry",
};

/** How the server's MCP startup states read in the contract's vocabulary. */
const MCP_STATUS: Readonly<Record<string, McpServerStatus>> = {
  starting: "connecting",
  ready: "connected",
  failed: "failed",
  cancelled: "disabled",
};

/** The server's plan-step states as a todo's. */
const TODO_STATUS: Readonly<Record<string, Todo["status"]>> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
};

export interface Translator {
  readonly translate: (
    notification: Notification,
    turn: TurnContext | null,
  ) => ReadonlyArray<PendingRuntimeEvent>;
}

export const makeTranslator = (options: {
  /** What the user types to sign the CLI in, for an error that is the sign-in. */
  readonly loginCommand: string;
}): Translator => {
  const rows = makeItemRows();
  const usage = makeUsageTracker();
  const mcp = new Map<string, McpServerStatus>();
  /** The turn the checklist row and the error flag belong to. */
  let turnSeen: TurnId | null = null;
  let todoRow: { readonly itemId: ItemId; todos: ReadonlyArray<Todo> } | null = null;
  let errorReported = false;

  const enterTurn = (turn: TurnContext | null): void => {
    if (turn === null || turn.turnId === turnSeen) return;
    turnSeen = turn.turnId;
    todoRow = null;
    errorReported = false;
    usage.startTurn();
  };

  /** The error text, and whether it is the sign-in. */
  const errorOf = (value: unknown): { readonly message: string; readonly auth: boolean } | null => {
    const error = asRecord(value);
    const message = nonEmpty(error.message);
    if (message === undefined) return null;
    const auth = error.codexErrorInfo === "unauthorized";
    const details = nonEmpty(error.additionalDetails);
    const text = details === undefined ? message : `${message}\n${details}`;
    return {
      message: auth ? `${text}\nSign in again with \`${options.loginCommand}\`.` : text,
      auth,
    };
  };

  const warning = (message: string | undefined): ReadonlyArray<PendingRuntimeEvent> =>
    message === undefined ? [] : [{ type: "session.warning", payload: { message } }];

  const todos = (params: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const list = asArray(params.plan).flatMap((entry, index): Array<Todo> => {
      const step = asRecord(entry);
      const text = nonEmpty(step.step);
      if (text === undefined) return [];
      return [
        {
          todoId: `todo-${index}`,
          text,
          status: TODO_STATUS[asString(step.status) ?? ""] ?? "pending",
        },
      ];
    });
    const explanation = nonEmpty(params.explanation);
    const opened = todoRow === null;
    todoRow ??= { itemId: makeItemId(), todos: [] };
    todoRow.todos = list;
    const { itemId } = todoRow;
    return [
      {
        itemId,
        type: opened ? "item.started" : "item.updated",
        payload: {
          item: {
            itemId,
            kind: "todo",
            status: "in_progress",
            todos: list,
            ...(explanation === undefined ? {} : { text: explanation }),
          },
        },
      },
    ];
  };

  const completeTurn = (
    params: Json,
    turn: TurnContext | null,
  ): ReadonlyArray<PendingRuntimeEvent> => {
    const events: Array<PendingRuntimeEvent> = [...rows.failOpen()];
    if (todoRow !== null) {
      const { itemId, todos: list } = todoRow;
      events.push({
        itemId,
        type: "item.completed",
        payload: { item: { itemId, kind: "todo", status: "completed", todos: list } },
      });
      todoRow = null;
    }
    if (turn === null) return events;
    const codexTurn = asRecord(params.turn);
    const status = asString(codexTurn.status);
    const stopReason = turn.interrupted
      ? "interrupted"
      : status === "completed"
        ? "end_turn"
        : status === "interrupted"
          ? "interrupted"
          : "error";
    if (stopReason === "error" && !errorReported) {
      const error = errorOf(codexTurn.error);
      events.push({
        type: "runtime.error",
        payload: {
          message: error?.message ?? `the turn ended ${status ?? "without a status"}`,
          fatal: error?.auth ?? false,
        },
      });
    }
    events.push({ type: "turn.completed", payload: { turnId: turn.turnId, stopReason } });
    return events;
  };

  const translate: Translator["translate"] = (notification, turn) => {
    enterTurn(turn);
    const { method } = notification;
    const params = asRecord(notification.params);
    if (method in IGNORED) return [];
    switch (method) {
      case "item/started":
        return rows.started(asRecord(params.item));
      case "item/completed":
        return rows.completed(asRecord(params.item));
      case "item/agentMessage/delta":
        return rows.delta(
          asString(params.itemId) ?? "",
          "agentMessage",
          asString(params.delta) ?? "",
        );
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return rows.delta(asString(params.itemId) ?? "", "reasoning", asString(params.delta) ?? "");
      case "item/plan/delta":
        return rows.delta(asString(params.itemId) ?? "", "plan", asString(params.delta) ?? "");
      case "item/commandExecution/outputDelta":
        return rows.commandOutput(asString(params.itemId) ?? "", asString(params.delta) ?? "");
      case "item/fileChange/patchUpdated":
        return rows.patchUpdated(asString(params.itemId) ?? "", params.changes);
      case "turn/plan/updated":
        return todos(params);
      case "thread/tokenUsage/updated":
        return usage.update(params, turn?.turnId ?? null);
      case "turn/completed":
        return completeTurn(params, turn);
      case "error": {
        const error = errorOf(params.error);
        if (error === null) return [unmapped(notification)];
        if (params.willRetry === true) return warning(`Codex is retrying: ${error.message}`);
        errorReported = true;
        return [{ type: "runtime.error", payload: { message: error.message, fatal: error.auth } }];
      }
      case "warning":
      case "guardianWarning":
        return warning(nonEmpty(params.message));
      case "configWarning":
      case "deprecationNotice": {
        const summary = nonEmpty(params.summary);
        const details = nonEmpty(params.details);
        return warning(
          summary === undefined
            ? details
            : details === undefined
              ? summary
              : `${summary}: ${details}`,
        );
      }
      case "model/rerouted":
        return warning(
          `Codex moved this turn from ${asString(params.fromModel) ?? "its model"} to ${asString(params.toModel) ?? "another model"}`,
        );
      case "mcpServer/startupStatus/updated": {
        const name = nonEmpty(params.name);
        const status = MCP_STATUS[asString(params.status) ?? ""];
        if (name === undefined || status === undefined) return [unmapped(notification)];
        mcp.set(name, status);
        return [
          {
            type: "mcp.status.updated",
            payload: {
              servers: [...mcp].map(([server, state]) => ({ name: server, status: state })),
            },
          },
        ];
      }
      default:
        return [unmapped(notification)];
    }
  };

  return { translate };
};
