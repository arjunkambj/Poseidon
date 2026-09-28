/**
 * A JSON-RPC 2.0 client over a child's stdio, one message per line.
 *
 * `codex app-server` speaks newline-delimited JSON-RPC on its stdin and
 * stdout, and leaves the `"jsonrpc": "2.0"` member out of every message it
 * sends (`fixtures/codex/probe/`); this client writes its own messages the
 * same way. Three kinds of message arrive:
 *
 * - a response — `id` and `result` or `error` — settles the request this
 *   client sent with that id. Ids are integers counted up from 1;
 * - a notification — `method` and no `id` — goes to every notification
 *   listener;
 * - a server request — `method` and `id` — goes to the request listeners, and
 *   whoever handles it answers with `respond(id, …)`. A request that arrives
 *   while no listener is registered is answered "method not found" at once,
 *   so the server is never left waiting on a client that cannot answer.
 *
 * When the peer goes — stdout ends or the process exits — every pending
 * request fails with why, and so does every request made after.
 */

import * as NodeReadline from "node:readline";
import type { Readable, Writable } from "node:stream";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ChildExit } from "./spawn";

export type RpcId = number | string;

export interface RpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A request the server answered with an error, or one the server went away from. */
export class RpcFailed extends Data.TaggedError("RpcFailed")<{
  readonly method: string;
  /** The JSON-RPC error code; absent when the server went away instead of answering. */
  readonly code?: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

export interface RpcNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface RpcServerRequest {
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown;
}

/** What a server request is answered with. */
export type RpcOutcome = { readonly result: unknown } | { readonly error: RpcErrorBody };

/** The pipes and exit of the process the client talks to. */
export interface RpcTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly exited: Promise<ChildExit>;
  readonly stderrTail?: () => string;
}

export interface RpcClient {
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, RpcFailed>;
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>;
  readonly respond: (id: RpcId, outcome: RpcOutcome) => Effect.Effect<void>;
  /** Registers a listener; the returned function removes it. */
  readonly onNotification: (listener: (notification: RpcNotification) => void) => () => void;
  readonly onRequest: (listener: (request: RpcServerRequest) => void) => () => void;
  /** Settles with why the peer went, once it has. */
  readonly closed: Promise<string>;
}

/** JSON-RPC's own code for a method the receiver does not implement. */
export const METHOD_NOT_FOUND = -32601;

/** The last non-empty line of a stderr tail, for an exit message. */
const lastLine = (tail: string): string =>
  tail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? "";

/** How a child's exit reads in an error message. */
export const describeExit = (exit: ChildExit, stderrTail = ""): string => {
  const how =
    exit.error !== undefined
      ? `could not start: ${exit.error}`
      : exit.signal !== null
        ? `was killed by ${exit.signal}`
        : `exited with code ${exit.code}`;
  const said = lastLine(stderrTail);
  return said === "" ? `app-server ${how}` : `app-server ${how}: ${said}`;
};

interface Pending {
  readonly method: string;
  readonly settle: (effect: Effect.Effect<unknown, RpcFailed>) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is RpcId =>
  typeof value === "number" || typeof value === "string";

const errorBodyOf = (value: unknown): RpcErrorBody => {
  if (!isRecord(value)) return { code: 0, message: String(value) };
  return {
    code: typeof value.code === "number" ? value.code : 0,
    message: typeof value.message === "string" ? value.message : JSON.stringify(value),
    ...(value.data === undefined ? {} : { data: value.data }),
  };
};

export const makeRpcClient = (
  transport: RpcTransport,
  hooks?: {
    /** A line that is not a JSON-RPC message, for the session's log. */
    readonly onUnparsed?: (line: string) => void;
  },
): RpcClient => {
  const pending = new Map<RpcId, Pending>();
  const notificationListeners = new Set<(notification: RpcNotification) => void>();
  const requestListeners = new Set<(request: RpcServerRequest) => void>();
  let nextId = 1;
  let closedReason: string | undefined;
  let markClosed: (reason: string) => void = () => {};
  const closed = new Promise<string>((resolve) => {
    markClosed = (reason) => {
      if (closedReason !== undefined) return;
      closedReason = reason;
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.settle(Effect.fail(new RpcFailed({ method: entry.method, message: reason })));
      }
      resolve(reason);
    };
  });

  const write = (message: Record<string, unknown>): void => {
    if (closedReason !== undefined || transport.stdin.writableEnded) return;
    transport.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const respond = (id: RpcId, outcome: RpcOutcome): Effect.Effect<void> =>
    Effect.sync(() => write({ id, ...outcome }));

  const dispatch = (line: string): void => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      hooks?.onUnparsed?.(line);
      return;
    }
    if (!isRecord(message)) {
      hooks?.onUnparsed?.(line);
      return;
    }
    const { id, method } = message;
    if (typeof method === "string") {
      if (isId(id)) {
        const request = { id, method, params: message.params };
        if (requestListeners.size === 0) {
          write({ id, error: { code: METHOD_NOT_FOUND, message: `${method} is not handled` } });
          return;
        }
        for (const listener of requestListeners) listener(request);
        return;
      }
      for (const listener of notificationListeners) listener({ method, params: message.params });
      return;
    }
    if (isId(id)) {
      const entry = pending.get(id);
      if (entry === undefined) {
        hooks?.onUnparsed?.(line);
        return;
      }
      pending.delete(id);
      if ("error" in message && message.error !== undefined && message.error !== null) {
        const body = errorBodyOf(message.error);
        entry.settle(
          Effect.fail(
            new RpcFailed({
              method: entry.method,
              code: body.code,
              message: body.message,
              ...(body.data === undefined ? {} : { data: body.data }),
            }),
          ),
        );
        return;
      }
      entry.settle(Effect.succeed(message.result));
      return;
    }
    hooks?.onUnparsed?.(line);
  };

  const lines = NodeReadline.createInterface({ input: transport.stdout, crlfDelay: Infinity });
  lines.on("line", dispatch);
  lines.on("close", () => {
    // The exit, when it comes, explains more than the end of stdout does.
    void Promise.race([
      transport.exited,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
    ]).then((exit) =>
      markClosed(
        exit === undefined
          ? "app-server closed its output"
          : describeExit(exit, transport.stderrTail?.()),
      ),
    );
  });
  void transport.exited.then((exit) => markClosed(describeExit(exit, transport.stderrTail?.())));

  return {
    request: (method, params) =>
      Effect.callback<unknown, RpcFailed>((resume) => {
        if (closedReason !== undefined) {
          resume(Effect.fail(new RpcFailed({ method, message: closedReason })));
          return;
        }
        const id = nextId;
        nextId += 1;
        pending.set(id, { method, settle: resume });
        write({ id, method, ...(params === undefined ? {} : { params }) });
        return Effect.sync(() => {
          pending.delete(id);
        });
      }),
    notify: (method, params) =>
      Effect.sync(() => write({ method, ...(params === undefined ? {} : { params }) })),
    respond,
    onNotification: (listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onRequest: (listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    closed,
  };
};
