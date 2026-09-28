/**
 * The JSON-RPC client against in-memory pipes: correlation, notifications,
 * server requests and the end of the peer. The wire shape itself — no
 * `jsonrpc` member either way — is checked against the probe recording.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "@effect/vitest";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import { CODEX_KIND } from "./kind";
import { INITIALIZE_PARAMS } from "./handshake";
import {
  METHOD_NOT_FOUND,
  describeExit,
  makeRpcClient,
  type RpcNotification,
  type RpcServerRequest,
} from "./rpc";
import type { ChildExit } from "./spawn";

/**
 * A client wired to pipes the test plays the server on. What the client
 * writes, what it could not parse, and what reaches the test's listeners each
 * land in a queue the test takes from — no test waits on a clock.
 */
const wired = Effect.gen(function* () {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let exit: (value: ChildExit) => void = () => {};
  const exited = new Promise<ChildExit>((resolve) => {
    exit = resolve;
  });
  const written = yield* Queue.unbounded<Record<string, unknown>>();
  const unparsed = yield* Queue.unbounded<string>();
  let pendingText = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    pendingText += chunk;
    const lines = pendingText.split("\n");
    pendingText = lines.pop() ?? "";
    for (const line of lines) {
      Queue.offerUnsafe(written, JSON.parse(line) as Record<string, unknown>);
    }
  });
  const rpc = makeRpcClient(
    { stdin, stdout, exited, stderrTail: () => "boom: config error\n" },
    { onUnparsed: (line) => Queue.offerUnsafe(unparsed, line) },
  );
  const send = (message: unknown): void => {
    stdout.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  };
  return { rpc, written, unparsed, send, exit, stdout };
});

describe("makeRpcClient", () => {
  it.effect("numbers requests from 1 and settles each by its own id", () =>
    Effect.gen(function* () {
      const { rpc, written, send } = yield* wired;
      const first = yield* Effect.forkChild(rpc.request("a/one", { x: 1 }));
      const second = yield* Effect.forkChild(rpc.request("a/two"));
      expect(yield* Queue.take(written)).toEqual({ id: 1, method: "a/one", params: { x: 1 } });
      expect(yield* Queue.take(written)).toEqual({ id: 2, method: "a/two" });
      // Answered out of order.
      send({ id: 2, result: "two" });
      send({ id: 1, result: { one: true } });
      expect(yield* Fiber.join(second)).toBe("two");
      expect(yield* Fiber.join(first)).toEqual({ one: true });
    }),
  );

  it.effect("fails a request the server answers with an error, with its code", () =>
    Effect.gen(function* () {
      const { rpc, written, send } = yield* wired;
      const call = yield* Effect.forkChild(Effect.flip(rpc.request("thread/resume")));
      yield* Queue.take(written);
      send({ id: 1, error: { code: -32600, message: "no rollout found" } });
      const error = yield* Fiber.join(call);
      expect(error).toMatchObject({
        _tag: "RpcFailed",
        method: "thread/resume",
        code: -32600,
        message: "no rollout found",
      });
    }),
  );

  it.effect("hands notifications to every listener until it is removed", () =>
    Effect.gen(function* () {
      const { rpc, send } = yield* wired;
      const first = yield* Queue.unbounded<RpcNotification>();
      const second = yield* Queue.unbounded<RpcNotification>();
      const remove = rpc.onNotification((notification) => Queue.offerUnsafe(first, notification));
      rpc.onNotification((notification) => Queue.offerUnsafe(second, notification));
      send({ method: "turn/started", params: { turn: { id: "t1" } }, emittedAtMs: 1 });
      expect(yield* Queue.take(first)).toEqual({
        method: "turn/started",
        params: { turn: { id: "t1" } },
      });
      yield* Queue.take(second);
      remove();
      send({ method: "turn/completed", params: {} });
      // Every listener hears a message in the same dispatch, so once the one
      // still registered has it, the removed one would have had it too.
      expect((yield* Queue.take(second)).method).toBe("turn/completed");
      expect(yield* Queue.size(first)).toBe(0);
    }),
  );

  it.effect("hands server requests to a listener, which answers them by id", () =>
    Effect.gen(function* () {
      const { rpc, written, send } = yield* wired;
      const seen = yield* Queue.unbounded<RpcServerRequest>();
      rpc.onRequest((request) => Queue.offerUnsafe(seen, request));
      send({ id: 0, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
      expect(yield* Queue.take(seen)).toEqual({
        id: 0,
        method: "item/commandExecution/requestApproval",
        params: { command: "ls" },
      });
      yield* rpc.respond(0, { result: { decision: "accept" } });
      expect(yield* Queue.take(written)).toEqual({ id: 0, result: { decision: "accept" } });
    }),
  );

  it.effect("answers a server request no listener takes with method-not-found", () =>
    Effect.gen(function* () {
      const { written, send } = yield* wired;
      send({ id: 7, method: "attestation/generate", params: {} });
      expect(yield* Queue.take(written)).toEqual({
        id: 7,
        error: { code: METHOD_NOT_FOUND, message: "attestation/generate is not handled" },
      });
    }),
  );

  it.effect("reports lines that are not JSON-RPC messages", () =>
    Effect.gen(function* () {
      const { unparsed, send } = yield* wired;
      send("not json");
      send("[1,2]");
      send({ id: 99, result: "nobody asked" });
      expect(yield* Queue.take(unparsed)).toBe("not json");
      expect(yield* Queue.take(unparsed)).toBe("[1,2]");
      expect(yield* Queue.take(unparsed)).toBe('{"id":99,"result":"nobody asked"}');
    }),
  );

  it.effect("fails pending and later requests once the process has exited", () =>
    Effect.gen(function* () {
      const { rpc, written, exit } = yield* wired;
      const call = yield* Effect.forkChild(Effect.flip(rpc.request("model/list")));
      yield* Queue.take(written);
      exit({ code: 1, signal: null });
      const error = yield* Fiber.join(call);
      expect(error.message).toBe("app-server exited with code 1: boom: config error");
      expect(error.code).toBeUndefined();
      const later = yield* Effect.flip(rpc.request("account/read"));
      expect(later.message).toBe(error.message);
      expect(yield* Effect.promise(() => rpc.closed)).toBe(error.message);
    }),
  );

  it.effect("fails pending requests when the output ends", () =>
    Effect.gen(function* () {
      const { rpc, written, stdout } = yield* wired;
      const call = yield* Effect.forkChild(Effect.flip(rpc.request("model/list")));
      yield* Queue.take(written);
      stdout.end();
      const error = yield* Fiber.join(call);
      expect(error.message).toBe("app-server closed its output");
    }),
  );
});

describe("describeExit", () => {
  it("says how the child ended, with its last stderr line", () => {
    expect(describeExit({ code: 0, signal: null })).toBe("app-server exited with code 0");
    expect(describeExit({ code: null, signal: "SIGTERM" }, "a\nlast words\n\n")).toBe(
      "app-server was killed by SIGTERM: last words",
    );
    expect(describeExit({ code: null, signal: null, error: "spawn codex ENOENT" })).toBe(
      "app-server could not start: spawn codex ENOENT",
    );
  });
});

describe("the recorded wire", () => {
  const handshake = loadStdioJsonRpcRecording(CODEX_KIND, "probe").invocations.find((invocation) =>
    invocation.argv.includes("app-server"),
  )!;

  it("carries no jsonrpc member in either direction", () => {
    for (const frame of handshake.frames) {
      expect(frame.data).not.toHaveProperty("jsonrpc");
    }
  });

  it("opens with the initialize request this client sends", () => {
    expect(handshake.frames[0]!.data).toEqual({
      id: 1,
      method: "initialize",
      params: INITIALIZE_PARAMS,
    });
  });
});
