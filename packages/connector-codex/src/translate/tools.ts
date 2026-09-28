/**
 * A thread's items as timeline rows.
 *
 * The app-server tells every item three ways: `item/started` with the item as
 * it begins, deltas while it runs, and `item/completed` with the item whole.
 * The item's own id keys the row, so the deltas grow the row the start opened
 * and the completion settles it. How each item type reads:
 *
 * | Item type                          | Row                                          |
 * | ---------------------------------- | -------------------------------------------- |
 * | `agentMessage`                     | `assistant_message`                          |
 * | `reasoning`                        | `reasoning`, its summary (or its text)       |
 * | `plan`                             | `plan`, its markdown                         |
 * | `commandExecution`                 | `command_execution`: command, cwd, output, exit |
 * | `fileChange`                       | `file_change`, one row per changed path      |
 * | `mcpToolCall`                      | `mcp_tool_call`, naming the server           |
 * | `webSearch`                        | `web_search`, the query                      |
 * | `contextCompaction`                | `context_compaction`                         |
 * | `collabAgentToolCall`              | `task`, the prompt it hands over             |
 * | `userMessage`                      | nothing: the server writes the user's row    |
 * | anything else                      | `tool_call`, named by its type               |
 *
 * A file change can touch several paths. Each path is its own row, because a
 * row's `fileChange` names one path: the first keeps the item's row, and every
 * further path gets a row of its own, in the order the item lists them.
 *
 * A finished row is never put back to running, nor finished twice. A turn's
 * rows still open when the turn ends are failed there (`failOpen`), so none
 * spins under an idle thread, and a late report of one of those items opens
 * no second row. Output is cut at `MAX_TOOL_OUTPUT_CHARS`.
 */

import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import { makeItemId } from "@poseidon/contracts/ids";
import type { FileChangeKind, ItemSnapshot, ItemStatus } from "@poseidon/contracts/runtime";

import {
  asArray,
  asNumber,
  asRecord,
  asString,
  nonEmpty,
  truncateToolOutput,
  MAX_TOOL_OUTPUT_CHARS,
  type Json,
  type PendingRuntimeEvent,
} from "./pending";

/** A row's body: everything of its snapshot but the id and status. */
type Body = Omit<ItemSnapshot, "itemId" | "status">;

/** How the item's own status reads; absent when the item carries none. */
const STATUS: Readonly<Record<string, ItemStatus>> = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  declined: "failed",
  // Collaboration-agent calls.
  pendingInit: "in_progress",
  running: "in_progress",
  interrupted: "failed",
  errored: "failed",
  shutdown: "completed",
  notFound: "failed",
};

const statusOf = (item: Json): ItemStatus | undefined => STATUS[asString(item.status) ?? ""];

const CHANGE_KIND: Readonly<Record<string, FileChangeKind>> = {
  add: "create",
  delete: "delete",
  update: "edit",
};

/** One entry of a file change's `changes`, as the row reads it. */
interface Change {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly diff?: string;
}

export const changesOf = (value: unknown): ReadonlyArray<Change> =>
  asArray(value).flatMap((entry): Array<Change> => {
    const change = asRecord(entry);
    const path = nonEmpty(change.path);
    if (path === undefined) return [];
    const kind = CHANGE_KIND[asString(asRecord(change.kind).type) ?? ""] ?? "edit";
    const diff = nonEmpty(change.diff);
    return [{ path, kind, ...(diff === undefined ? {} : { diff: truncateToolOutput(diff) }) }];
  });

/** The item types that are no row of ours. */
const NO_ROW = new Set(["userMessage"]);

/** The row kind an item type is drawn as. */
export const kindOfItem = (type: string): ItemKind => {
  switch (type) {
    case "agentMessage":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "plan":
      return "plan";
    case "commandExecution":
      return "command_execution";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
      return "mcp_tool_call";
    case "webSearch":
      return "web_search";
    case "contextCompaction":
      return "context_compaction";
    case "collabAgentToolCall":
      return "task";
    default:
      return "tool_call";
  }
};

/** The text a reasoning item shows: its summary, or its raw text when it has none. */
const reasoningText = (item: Json): string => {
  const summary = asArray(item.summary).flatMap((part) =>
    typeof part === "string" && part !== "" ? [part] : [],
  );
  const parts =
    summary.length > 0
      ? summary
      : asArray(item.content).flatMap((part) =>
          typeof part === "string" && part !== "" ? [part] : [],
        );
  return parts.join("\n\n");
};

/** The body of every row but a file change's, from the item as it stands. */
const bodyOf = (type: string, item: Json, output: string): Body => {
  const kind = kindOfItem(type);
  switch (kind) {
    case "assistant_message": {
      const text = asString(item.text);
      return { kind, ...(text === undefined || text === "" ? {} : { text }) };
    }
    case "reasoning": {
      const text = reasoningText(item);
      return { kind, ...(text === "" ? {} : { text }) };
    }
    case "plan": {
      const text = asString(item.text) ?? "";
      return { kind, ...(text === "" ? {} : { text, plan: { markdown: text } }) };
    }
    case "command_execution": {
      const cwd = asString(item.cwd);
      const exitCode = asNumber(item.exitCode);
      const aggregated = asString(item.aggregatedOutput);
      const shown = aggregated ?? output;
      return {
        kind,
        command: {
          cmd: nonEmpty(item.command) ?? "command",
          ...(cwd === undefined ? {} : { cwd }),
          ...(exitCode === undefined ? {} : { exitCode: Math.trunc(exitCode) }),
          ...(shown === "" ? {} : { output: truncateToolOutput(shown) }),
        },
      };
    }
    case "mcp_tool_call": {
      const server = asString(item.server);
      const result = item.result ?? item.error;
      return {
        kind,
        tool: {
          name: nonEmpty(item.tool) ?? "tool",
          ...(server === undefined ? {} : { server }),
          input: item.arguments ?? null,
          ...(result === undefined || result === null ? {} : { output: result }),
        },
      };
    }
    case "web_search": {
      const query = nonEmpty(item.query);
      return {
        kind,
        ...(query === undefined ? {} : { text: query }),
        tool: { name: "web_search", input: { query: query ?? "", action: item.action ?? null } },
      };
    }
    case "context_compaction":
      return { kind };
    case "task": {
      const prompt = nonEmpty(item.prompt);
      return {
        kind,
        ...(prompt === undefined ? {} : { text: prompt }),
        tool: { name: nonEmpty(item.tool) ?? type, input: item },
      };
    }
    default:
      return { kind, tool: { name: nonEmpty(item.tool) ?? type, input: item } };
  }
};

interface Row {
  readonly itemId: ItemId;
  status: ItemStatus;
  body: Body;
}

/** One item of the server's, and the row or rows it is drawn as. */
interface Entry {
  readonly type: string;
  /** One row per changed path for a file change; one row for anything else. */
  readonly rows: Array<Row>;
  /** Streamed command output, for a command whose item carries none yet. */
  output: string;
  done: boolean;
}

export interface ItemRows {
  readonly started: (item: Json) => ReadonlyArray<PendingRuntimeEvent>;
  readonly completed: (item: Json) => ReadonlyArray<PendingRuntimeEvent>;
  /** A text, reasoning or plan delta; opens the row when its start never came. */
  readonly delta: (
    itemId: string,
    type: "agentMessage" | "reasoning" | "plan",
    delta: string,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** Another piece of a running command's output. */
  readonly commandOutput: (itemId: string, delta: string) => ReadonlyArray<PendingRuntimeEvent>;
  /** A file change's patch, as it now stands. */
  readonly patchUpdated: (itemId: string, changes: unknown) => ReadonlyArray<PendingRuntimeEvent>;
  /** Fails every row still open; the turn they belonged to is over. */
  readonly failOpen: () => ReadonlyArray<PendingRuntimeEvent>;
}

const snapshot = (row: Row): ItemSnapshot => ({
  itemId: row.itemId,
  status: row.status,
  ...row.body,
});

const rowEvent = (
  type: "item.started" | "item.updated" | "item.completed",
  row: Row,
): PendingRuntimeEvent => ({ itemId: row.itemId, type, payload: { item: snapshot(row) } });

export const makeItemRows = (): ItemRows => {
  const entries = new Map<string, Entry>();
  /**
   * The items an ended turn left open and `failOpen` settled. The CLI can
   * still report one after the next turn started — a stopped turn's file
   * change completes late — and that report must not open a second row.
   */
  const settled = new Set<string>();

  /**
   * The rows of a file change, one per path: rows it already has keep their
   * ids and take the path's new body, and a path it did not have opens one.
   */
  const fileRows = (
    entry: Entry,
    changes: ReadonlyArray<Change>,
    status: ItemStatus,
  ): ReadonlyArray<PendingRuntimeEvent> =>
    changes.map((change, index) => {
      const body: Body = {
        kind: "file_change",
        fileChange: {
          path: change.path,
          kind: change.kind,
          ...(change.diff === undefined ? {} : { diff: change.diff }),
        },
      };
      const existing = entry.rows[index];
      if (existing === undefined) {
        const row: Row = { itemId: makeItemId(), status, body };
        entry.rows.push(row);
        return rowEvent(status === "in_progress" ? "item.started" : "item.completed", row);
      }
      existing.body = body;
      existing.status = status;
      return rowEvent(status === "in_progress" ? "item.updated" : "item.completed", existing);
    });

  const open = (id: string, type: string): Entry => {
    const entry: Entry = { type, rows: [], output: "", done: false };
    entries.set(id, entry);
    return entry;
  };

  const started = (item: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const id = asString(item.id);
    const type = asString(item.type) ?? "unknown";
    if (id === undefined || NO_ROW.has(type) || entries.has(id) || settled.has(id)) return [];
    const entry = open(id, type);
    if (type === "fileChange") return fileRows(entry, changesOf(item.changes), "in_progress");
    const row: Row = { itemId: makeItemId(), status: "in_progress", body: bodyOf(type, item, "") };
    entry.rows.push(row);
    return [rowEvent("item.started", row)];
  };

  const completed = (item: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const id = asString(item.id);
    const type = asString(item.type) ?? "unknown";
    if (id === undefined || NO_ROW.has(type) || settled.has(id)) return [];
    const entry = entries.get(id) ?? open(id, type);
    if (entry.done) return [];
    entry.done = true;
    const reported = statusOf(item);
    const status: ItemStatus =
      reported === undefined || reported === "in_progress" ? "completed" : reported;
    if (type === "fileChange") {
      const events = fileRows(entry, changesOf(item.changes), status);
      // Paths the item no longer lists settle as they stood.
      const extra = entry.rows.slice(events.length).map((row) => {
        row.status = status;
        return rowEvent("item.completed", row);
      });
      return [...events, ...extra];
    }
    const body = bodyOf(type, item, entry.output);
    const row = entry.rows[0];
    if (row === undefined) {
      const fresh: Row = { itemId: makeItemId(), status, body };
      entry.rows.push(fresh);
      return [rowEvent("item.completed", fresh)];
    }
    row.body = body;
    row.status = status;
    return [rowEvent("item.completed", row)];
  };

  const delta: ItemRows["delta"] = (id, type, text) => {
    if (text === "" || settled.has(id)) return [];
    const opened = entries.has(id) ? [] : started({ id, type });
    const entry = entries.get(id);
    const row = entry?.rows[0];
    if (entry === undefined || row === undefined || entry.done) return opened;
    return [
      ...opened,
      {
        itemId: row.itemId,
        type: "content.delta",
        payload: {
          itemId: row.itemId,
          kind: type === "reasoning" ? "reasoning" : "text",
          delta: text,
        },
      },
    ];
  };

  const commandOutput: ItemRows["commandOutput"] = (id, text) => {
    const entry = entries.get(id);
    const row = entry?.rows[0];
    if (entry === undefined || row === undefined || entry.done || text === "") return [];
    if (entry.output.length <= MAX_TOOL_OUTPUT_CHARS) entry.output += text;
    const command = row.body.command;
    if (command === undefined) return [];
    row.body = { ...row.body, command: { ...command, output: truncateToolOutput(entry.output) } };
    return [rowEvent("item.updated", row)];
  };

  const patchUpdated: ItemRows["patchUpdated"] = (id, changes) => {
    if (settled.has(id)) return [];
    const entry = entries.get(id) ?? open(id, "fileChange");
    if (entry.done) return [];
    return fileRows(entry, changesOf(changes), "in_progress");
  };

  const failOpen = (): ReadonlyArray<PendingRuntimeEvent> => {
    const events: Array<PendingRuntimeEvent> = [];
    for (const [id, entry] of entries) {
      if (entry.done) continue;
      entry.done = true;
      settled.add(id);
      for (const row of entry.rows) {
        row.status = "failed";
        events.push(rowEvent("item.completed", row));
      }
    }
    // The turn is over: nothing it opened is streamed into again.
    entries.clear();
    return events;
  };

  return { started, completed, delta, commandOutput, patchUpdated, failOpen };
};
