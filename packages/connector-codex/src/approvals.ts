/**
 * The app-server's approval requests, in Poseidon's approval vocabulary.
 *
 * The app-server asks before a command it does not count as safe
 * (`item/commandExecution/requestApproval`) and before every file change
 * (`item/fileChange/requestApproval`). Each becomes an `ApprovalRequest` the
 * permission ladder reads and the card shows, in the tool names and pattern
 * forms Poseidon uses for every harness (`@poseidon/shared/permissionPattern`,
 * docs/architecture.md "Permissions") — never the CLI's own:
 *
 * - a command is `Shell`, kind `command`, its input `{ command, cwd }` — the
 *   script inside the CLI's login-shell wrapper (`unwrapShell`) — and "allow
 *   always" starts from `Shell(<first word> *)`;
 * - a file change is `Edit`, kind `file_write`, its input `{ file_path }`,
 *   and "allow always" starts from `Edit(<path>)`.
 *
 * The file-change request names only the item it is about, not the paths:
 * those came with the item's `item/started`, which the server sends first, and
 * `makeFileChangePaths` keeps them by item id. A change that touches several
 * paths is one request per path, so the sensitive-path rung sees every one of
 * them rather than only the first.
 */

import type { ApprovalRequest } from "@poseidon/contracts/runtime";
import { makeRequestId } from "@poseidon/contracts/ids";

import { asArray, asRecord, asString, nonEmpty, type Json } from "./translate/pending";

/** The two requests that become approval cards. */
export const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
export const FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";

/** Poseidon's names for the two kinds of call, as the ladder and the card read them. */
export const SHELL_TOOL = "Shell";
export const EDIT_TOOL = "Edit";

/** At most this much of a command goes into the card's one line. */
const LINE_LIMIT = 200;

const clip = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}…` : line;
};

/**
 * The script a command runs, without the login-shell wrapper the CLI puts
 * around it (`/bin/zsh -lc 'touch denied.txt'`, or `/bin/zsh -lc ls`). The
 * ladder, the pattern and the card read the script: a rule for `npm run *`
 * would never match the wrapper, and every pattern would start `/bin/zsh`.
 */
export const unwrapShell = (command: string): string => {
  const trimmed = command.trim();
  const match = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(trimmed);
  if (match === null) return trimmed;
  const script = match[1]!.trim();
  const quote = script[0];
  return (quote === "'" || quote === '"') && script.length > 1 && script.endsWith(quote)
    ? script.slice(1, -1).trim()
    : script;
};

/** `Shell(<first word> *)`, or `Shell(*)` for a command with no words. */
export const shellPattern = (command: string | undefined): string => {
  const first = command?.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? "Shell(*)" : `Shell(${first} *)`;
};

/** A command approval as the ladder and the card read it. */
export const commandApprovalRequest = (params: unknown): ApprovalRequest => {
  const record = asRecord(params);
  const wrapped = nonEmpty(record.command);
  const command = wrapped === undefined ? undefined : nonEmpty(unwrapShell(wrapped));
  const cwd = nonEmpty(record.cwd);
  const reason = nonEmpty(record.reason);
  const stdin = asString(record.kind) === "writeStdin";
  const action = stdin
    ? "Write to the running command's terminal"
    : command === undefined
      ? "Run a shell command"
      : `Run ${clip(command)}`;
  return {
    requestId: makeRequestId(),
    kind: "command",
    toolName: SHELL_TOOL,
    input: {
      ...(command === undefined ? {} : { command }),
      ...(cwd === undefined ? {} : { cwd }),
    },
    patternSuggestion: shellPattern(command),
    description: reason === undefined ? action : `${action} — ${clip(reason)}`,
  };
};

/** One path of a file change as the ladder and the card read it. */
export const fileChangeApprovalRequest = (
  path: string | undefined,
  reason?: string,
): ApprovalRequest => {
  const action = path === undefined ? "Change files" : `Edit ${path}`;
  return {
    requestId: makeRequestId(),
    kind: "file_write",
    toolName: EDIT_TOOL,
    input: path === undefined ? {} : { file_path: path },
    patternSuggestion: `Edit(${path ?? "*"})`,
    description: reason === undefined ? action : `${action} — ${clip(reason)}`,
  };
};

/**
 * Every path a file change touches: each change's `path`, and the
 * destination of a move, which is written too.
 */
export const pathsOfChanges = (changes: unknown): ReadonlyArray<string> => {
  const paths = asArray(changes).flatMap((entry): Array<string> => {
    const change = asRecord(entry);
    const path = nonEmpty(change.path);
    const moved = nonEmpty(asRecord(change.kind).move_path);
    return [...(path === undefined ? [] : [path]), ...(moved === undefined ? [] : [moved])];
  });
  return [...new Set(paths)];
};

/**
 * The approval requests for one file-change request: one per path the item
 * touches. With no path known — an item the session never saw start — the
 * one request names the root the CLI asked to write under, if any, so the
 * mode still decides and the card still says what it can.
 */
export const fileChangeApprovalRequests = (
  params: unknown,
  pathsOf: (itemId: string) => ReadonlyArray<string> | undefined,
): ReadonlyArray<ApprovalRequest> => {
  const record = asRecord(params);
  const reason = nonEmpty(record.reason);
  const itemId = asString(record.itemId);
  const paths = itemId === undefined ? undefined : pathsOf(itemId);
  if (paths !== undefined && paths.length > 0) {
    return paths.map((path) => fileChangeApprovalRequest(path, reason));
  }
  return [fileChangeApprovalRequest(nonEmpty(record.grantRoot), reason)];
};

/** The file-change items' paths by item id, as their `item/started` gave them. */
export interface FileChangePaths {
  /** Reads an `item/started` or `item/completed`; remembers a file change's paths. */
  readonly observe: (method: string, params: unknown) => void;
  readonly pathsOf: (itemId: string) => ReadonlyArray<string> | undefined;
  /** Forgets every item; called when a turn ends. */
  readonly clear: () => void;
}

export const makeFileChangePaths = (): FileChangePaths => {
  const byItem = new Map<string, ReadonlyArray<string>>();
  return {
    observe: (method, params) => {
      if (method !== "item/started" && method !== "item/completed") return;
      const item: Json = asRecord(asRecord(params).item);
      const id = asString(item.id);
      if (asString(item.type) !== "fileChange" || id === undefined) return;
      const paths = pathsOfChanges(item.changes);
      if (paths.length > 0) byItem.set(id, paths);
    },
    pathsOf: (itemId) => byItem.get(itemId),
    clear: () => byItem.clear(),
  };
};
