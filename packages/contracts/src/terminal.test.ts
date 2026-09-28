import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeProjectId, makeTerminalId, makeThreadId } from "./ids";
import { PoseidonRpcGroup, RPC_METHODS } from "./rpc";
import {
  TERMINAL_BATCH_CHARS,
  TERMINAL_BATCH_MS,
  TERMINAL_SCRIPT_COMMAND_MAX_CHARS,
  TERMINAL_SCROLLBACK_CHARS,
  TERMINAL_STREAM_BUDGET_BYTES,
  TERMINAL_STREAM_BUDGET_ITEMS,
  TERMINAL_WRITE_MAX_CHARS,
  TERMINALS_PER_OWNER,
  TerminalSize,
  TerminalSummary,
  decodeTerminalOwnerKey,
  terminalOwnerKey,
  terminalOwnerOf,
} from "./terminal";

describe("TerminalSize", () => {
  it.effect("accepts a grid inside the bounds and refuses one outside them", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownExit(TerminalSize);
      for (const size of [
        { cols: 2, rows: 1 },
        { cols: 120, rows: 32 },
        { cols: 1000, rows: 500 },
      ]) {
        expect((yield* Effect.sync(() => decode(size)))._tag).toBe("Success");
      }
      for (const size of [
        { cols: 1, rows: 24 },
        { cols: 80, rows: 0 },
        { cols: 1001, rows: 24 },
        { cols: 80, rows: 501 },
        { cols: 80.5, rows: 24 },
      ]) {
        expect((yield* Effect.sync(() => decode(size)))._tag).toBe("Failure");
      }
    }),
  );
});

describe("terminal.write", () => {
  it.effect("refuses a payload longer than the write limit", () =>
    Effect.gen(function* () {
      const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.terminalWrite);
      expect(rpc).toBeDefined();
      const decode = Schema.decodeUnknownExit(rpc!.payloadSchema as Schema.Codec<unknown>);
      const ids = { threadId: makeThreadId(), terminalId: makeTerminalId() };
      const fits = yield* Effect.sync(() =>
        decode({ ...ids, data: "x".repeat(TERMINAL_WRITE_MAX_CHARS) }),
      );
      expect(fits._tag).toBe("Success");
      const tooLong = yield* Effect.sync(() =>
        decode({ ...ids, data: "x".repeat(TERMINAL_WRITE_MAX_CHARS + 1) }),
      );
      expect(tooLong._tag).toBe("Failure");
    }),
  );
});

describe("terminal.open", () => {
  it.effect("takes an optional script whose command is non-empty and bounded", () =>
    Effect.gen(function* () {
      const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.terminalOpen);
      expect(rpc).toBeDefined();
      const decode = Schema.decodeUnknownExit(rpc!.payloadSchema as Schema.Codec<unknown>);
      const base = { threadId: makeThreadId(), terminalId: makeTerminalId(), cols: 80, rows: 24 };
      const script = (command: string) => ({
        ...base,
        script: { id: "dev", name: "dev", command },
      });
      const tags = yield* Effect.sync(() => [
        decode(base)._tag,
        decode(script("pnpm run dev"))._tag,
        decode(script("x".repeat(TERMINAL_SCRIPT_COMMAND_MAX_CHARS)))._tag,
        decode(script("x".repeat(TERMINAL_SCRIPT_COMMAND_MAX_CHARS + 1)))._tag,
        decode(script(""))._tag,
      ]);
      expect(tags).toEqual(["Success", "Success", "Success", "Failure", "Failure"]);
    }),
  );
});

describe("the terminal owner", () => {
  const payloadOf = (method: string) => {
    const rpc = PoseidonRpcGroup.requests.get(method);
    expect(rpc).toBeDefined();
    return Schema.decodeUnknownExit(rpc!.payloadSchema as Schema.Codec<unknown>);
  };

  it.effect("is exactly one of a thread and a project on every call", () =>
    Effect.gen(function* () {
      const terminalId = makeTerminalId();
      const size = { cols: 80, rows: 24 };
      const calls = [
        [RPC_METHODS.terminalOpen, { terminalId, ...size }],
        [RPC_METHODS.terminalWrite, { terminalId, data: "ls\n" }],
        [RPC_METHODS.terminalResize, { terminalId, ...size }],
        [RPC_METHODS.terminalClose, { terminalId }],
        [RPC_METHODS.terminalSubscribe, { terminalId }],
        [RPC_METHODS.terminalList, {}],
      ] as const;
      for (const [method, rest] of calls) {
        const decode = payloadOf(method);
        const byThread = yield* Effect.sync(() => decode({ threadId: makeThreadId(), ...rest }));
        const byProject = yield* Effect.sync(() => decode({ projectId: makeProjectId(), ...rest }));
        const byNobody = yield* Effect.sync(() => decode(rest));
        const byBoth = yield* Effect.sync(() =>
          decode({ threadId: makeThreadId(), projectId: makeProjectId(), ...rest }),
        );
        expect([byThread._tag, byProject._tag, byNobody._tag, byBoth._tag], method).toEqual([
          "Success",
          "Success",
          "Failure",
          "Failure",
        ]);
      }
    }),
  );

  it.effect("decodes a summary without a script, and round-trips one with it", () =>
    Effect.gen(function* () {
      const summary = {
        terminalId: makeTerminalId(),
        threadId: makeThreadId(),
        title: "dev",
        cwd: "/repo",
        pid: 1,
        cols: 80,
        rows: 24,
        status: "exited",
        exitCode: 3,
        createdAt: "2026-09-24T12:00:00.000Z",
      };
      const decode = Schema.decodeUnknownSync(TerminalSummary);
      const encode = Schema.encodeSync(TerminalSummary);
      const withScript = { ...summary, script: { id: "dev", name: "dev" } };
      const [plain, roundTrip, empty] = yield* Effect.sync(() => [
        decode(summary),
        encode(decode(withScript)),
        Schema.decodeUnknownExit(TerminalSummary)({ ...summary, script: { id: "", name: "dev" } })
          ._tag,
      ]);
      expect(plain).toEqual(summary);
      expect(roundTrip).toEqual(withScript);
      expect(empty).toBe("Failure");
    }),
  );

  it.effect("refuses a summary that names both a thread and a project", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownExit(TerminalSummary);
      const summary = {
        terminalId: makeTerminalId(),
        title: "Terminal 1",
        cwd: "/repo",
        pid: 1,
        cols: 80,
        rows: 24,
        status: "running",
        exitCode: null,
        createdAt: "2026-09-24T12:00:00.000Z",
      };
      const threadId = makeThreadId();
      const projectId = makeProjectId();
      const tags = yield* Effect.sync(() => [
        decode({ ...summary, threadId })._tag,
        decode({ ...summary, projectId })._tag,
        decode({ ...summary, threadId, projectId })._tag,
      ]);
      expect(tags).toEqual(["Success", "Success", "Failure"]);
    }),
  );

  it.effect("keys a thread by its bare id and a project apart from it, both ways", () =>
    Effect.gen(function* () {
      const threadId = makeThreadId();
      const projectId = makeProjectId();
      const keys = yield* Effect.succeed({
        thread: terminalOwnerKey({ threadId }),
        project: terminalOwnerKey({ projectId }),
      });
      expect(keys.thread).toBe(threadId);
      expect(keys.project).toBe(`project:${projectId}`);
      expect(decodeTerminalOwnerKey(keys.thread)).toEqual({ threadId });
      expect(decodeTerminalOwnerKey(keys.project)).toEqual({ projectId });
    }),
  );

  it.effect("is read off a payload without the rest of it", () =>
    Effect.gen(function* () {
      const threadId = makeThreadId();
      const projectId = makeProjectId();
      const terminalId = makeTerminalId();
      const byThread = { threadId, terminalId, cols: 80, rows: 24 };
      const byProject = { projectId, terminalId, data: "ls\n" };
      const owners = yield* Effect.sync(() => [
        terminalOwnerOf(byThread),
        terminalOwnerOf(byProject),
      ]);
      expect(owners).toEqual([{ threadId }, { projectId }]);
    }),
  );
});

describe("terminal.adopt", () => {
  it.effect("names the project that hands its terminals over and the thread that takes them", () =>
    Effect.gen(function* () {
      const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.terminalAdopt);
      expect(rpc).toBeDefined();
      const decode = Schema.decodeUnknownExit(rpc!.payloadSchema as Schema.Codec<unknown>);
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const tags = yield* Effect.sync(() => [
        decode({ projectId, threadId })._tag,
        decode({ projectId })._tag,
        decode({ threadId })._tag,
      ]);
      expect(tags).toEqual(["Success", "Failure", "Failure"]);
    }),
  );
});

describe("the terminal limits", () => {
  it.effect("are the ones the contract names, so server and client cannot drift", () =>
    Effect.gen(function* () {
      const limits = yield* Effect.succeed({
        scrollbackChars: TERMINAL_SCROLLBACK_CHARS,
        batchMs: TERMINAL_BATCH_MS,
        batchChars: TERMINAL_BATCH_CHARS,
        streamBytes: TERMINAL_STREAM_BUDGET_BYTES,
        streamItems: TERMINAL_STREAM_BUDGET_ITEMS,
        perOwner: TERMINALS_PER_OWNER,
        writeChars: TERMINAL_WRITE_MAX_CHARS,
      });
      expect(limits).toEqual({
        scrollbackChars: 1_048_576,
        batchMs: 16,
        batchChars: 65_536,
        streamBytes: 4_194_304,
        streamItems: 4096,
        perOwner: 8,
        writeChars: 1_048_576,
      });
    }),
  );

  it.effect("keep one output batch well inside the scrollback", () =>
    Effect.gen(function* () {
      const limits = yield* Effect.succeed({
        batch: TERMINAL_BATCH_CHARS,
        scrollback: TERMINAL_SCROLLBACK_CHARS,
      });
      expect(limits.batch).toBeLessThan(limits.scrollback);
    }),
  );
});
