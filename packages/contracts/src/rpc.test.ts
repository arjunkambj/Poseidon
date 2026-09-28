import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import {
  BrowserToolStatus,
  DEV_SERVER_LIMIT,
  DevServer,
  FILES_STAT_MAX_PATHS,
  FS_BROWSE_ENTRY_LIMIT,
  FsBrowseFailure,
  PoseidonRpcGroup,
  PROTOCOL_VERSION,
  RPC_METHODS,
  STREAM_BUDGET_BYTES,
  STREAM_BUDGET_ITEMS,
  STREAM_COALESCE_MS,
} from "./rpc";
import { DetectedScript } from "./scripts";

const STREAMING_METHODS = [
  RPC_METHODS.threadsSubscribe,
  RPC_METHODS.threadsListSubscribe,
  RPC_METHODS.browserSubscribe,
  RPC_METHODS.settingsSubscribe,
  RPC_METHODS.gitWorktreeSetup,
  RPC_METHODS.terminalSubscribe,
];

describe("PoseidonRpcGroup", () => {
  it.effect("implements exactly the methods RPC_METHODS names", () =>
    Effect.gen(function* () {
      const tags = yield* Effect.succeed([...PoseidonRpcGroup.requests.keys()].sort());
      expect(tags).toEqual(Object.values(RPC_METHODS).sort());
    }),
  );

  it.effect("streams the five subscriptions and the setup script, and nothing else", () =>
    Effect.gen(function* () {
      const streaming = yield* Effect.succeed(
        [...PoseidonRpcGroup.requests.values()]
          .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
          .map((rpc) => rpc._tag)
          .sort(),
      );
      expect(streaming).toEqual([...STREAMING_METHODS].sort());
    }),
  );

  it.effect("gives every method a payload schema, so nothing is untyped on the wire", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.succeed(
        [...PoseidonRpcGroup.requests.values()]
          .filter((rpc) => rpc.payloadSchema === undefined)
          .map((rpc) => rpc._tag),
      );
      expect(missing).toEqual([]);
    }),
  );
});

describe("PROTOCOL_VERSION", () => {
  it.effect("is a positive integer a client can compare against", () =>
    Effect.gen(function* () {
      const version = yield* Effect.succeed(PROTOCOL_VERSION);
      expect(Number.isInteger(version)).toBe(true);
      expect(version).toBeGreaterThan(0);
    }),
  );
});

describe("fs.browse", () => {
  it.effect("caps a listing, so one directory can never be an unbounded frame", () =>
    Effect.gen(function* () {
      const limit = yield* Effect.succeed(FS_BROWSE_ENTRY_LIMIT);
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }),
  );

  it.effect("names every failure the picker has a different answer for", () =>
    Effect.gen(function* () {
      const reasons = yield* Effect.succeed([...FsBrowseFailure.literals].sort());
      expect(reasons).toEqual([
        "internal",
        "not-a-directory",
        "not-absolute",
        "not-found",
        "permission-denied",
      ]);
    }),
  );
});

describe("browser.discoverServers", () => {
  const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.browserDiscoverServers);
  const decode = Schema.decodeUnknownExit(DevServer);

  it("is a plain request keyed by the thread, answering a list of servers", () => {
    expect(rpc).toBeDefined();
    expect(RpcSchema.isStreamSchema(rpc!.successSchema)).toBe(false);
    const payload = Schema.decodeUnknownExit(rpc!.payloadSchema)({
      threadId: "0190aaaa-0000-7000-8000-000000000001",
    });
    expect(payload._tag).toBe("Success");
    const answer = Schema.decodeUnknownExit(rpc!.successSchema)([
      { url: "http://localhost:5173", port: 5173, processName: "node" },
      { url: "http://localhost:3000", port: 3000, processName: null },
    ]);
    expect(answer._tag).toBe("Success");
  });

  it("carries a port a socket can have, and a name only when there is one", () => {
    const server = { url: "http://localhost:5173", port: 5173, processName: "node" };
    expect(decode(server)._tag).toBe("Success");
    expect(decode({ ...server, port: 0 })._tag).toBe("Failure");
    expect(decode({ ...server, port: 65536 })._tag).toBe("Failure");
    expect(decode({ ...server, port: 51.5 })._tag).toBe("Failure");
    expect(decode({ ...server, processName: "" })._tag).toBe("Failure");
    expect(decode({ ...server, url: "" })._tag).toBe("Failure");
    expect(Number.isInteger(DEV_SERVER_LIMIT) && DEV_SERVER_LIMIT > 0).toBe(true);
  });
});

describe("browser.status", () => {
  const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.browserStatus);
  const decode = Schema.decodeUnknownExit(BrowserToolStatus);

  it("is a plain request answering the mode and agent-browser's version", () => {
    expect(rpc).toBeDefined();
    expect(RpcSchema.isStreamSchema(rpc!.successSchema)).toBe(false);
    expect(decode({ mode: "in-app", installed: true, version: "agent-browser 0.38.1" })._tag).toBe(
      "Success",
    );
    expect(decode({ mode: "disabled", installed: false, version: null })._tag).toBe("Success");
    expect(decode({ mode: "headless", installed: false, version: null })._tag).toBe("Failure");
    expect(decode({ mode: "in-app", installed: true, version: "" })._tag).toBe("Failure");
  });
});

describe("files.stat", () => {
  const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.filesStat);
  const projectId = "0190aaaa-0000-7000-8000-000000000001";

  it("is a plain request that takes a bounded batch of non-empty paths", () => {
    expect(rpc).toBeDefined();
    expect(RpcSchema.isStreamSchema(rpc!.successSchema)).toBe(false);
    const decode = Schema.decodeUnknownExit(rpc!.payloadSchema);
    const full = Array.from({ length: FILES_STAT_MAX_PATHS }, (_, i) => `src/${i}.ts`);
    expect(decode({ projectId, paths: [] })._tag).toBe("Success");
    expect(decode({ projectId, paths: full })._tag).toBe("Success");
    expect(decode({ projectId, paths: [...full, "one-more.ts"] })._tag).toBe("Failure");
    expect(decode({ projectId, paths: [""] })._tag).toBe("Failure");
  });

  it("answers a list in which a path is only ever one that exists", () => {
    const answer = Schema.decodeUnknownExit(rpc!.successSchema);
    const stat = {
      path: "./src/a.ts",
      relativePath: "src/a.ts",
      absolutePath: "/repo/src/a.ts",
      isDirectory: false,
    };
    expect(answer([stat])._tag).toBe("Success");
    expect(answer([{ ...stat, relativePath: "" }])._tag).toBe("Failure");
  });
});

describe("the stream budget", () => {
  it.effect("is the one the contract names, so server and client cannot drift", () =>
    Effect.gen(function* () {
      const budget = yield* Effect.succeed({
        items: STREAM_BUDGET_ITEMS,
        bytes: STREAM_BUDGET_BYTES,
        coalesceMs: STREAM_COALESCE_MS,
      });
      expect(budget).toEqual({ items: 1000, bytes: 8_388_608, coalesceMs: 50 });
    }),
  );
});

describe("editors.open", () => {
  const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.editorsOpen);
  const projectId = "0190aaaa-0000-7000-8000-000000000001";

  it("names a known app and a positive line, never a command", () => {
    expect(rpc).toBeDefined();
    expect(RpcSchema.isStreamSchema(rpc!.successSchema)).toBe(false);
    const decode = Schema.decodeUnknownExit(rpc!.payloadSchema);
    expect(decode({ projectId, editor: "cursor" })._tag).toBe("Success");
    expect(decode({ projectId, editor: "zed", path: "src/a.ts", line: 12 })._tag).toBe("Success");
    expect(decode({ projectId, editor: "finder", path: "src", reveal: true })._tag).toBe("Success");
    expect(decode({ projectId, editor: "/bin/sh" })._tag).toBe("Failure");
    expect(decode({ projectId, editor: "vscode", line: 0 })._tag).toBe("Failure");
    expect(decode({ projectId, editor: "vscode", line: 1.5 })._tag).toBe("Failure");
  });
});

describe("scripts.detect", () => {
  const rpc = PoseidonRpcGroup.requests.get(RPC_METHODS.scriptsDetect);
  const projectId = "0190aaaa-0000-7000-8000-000000000001";
  const script = {
    id: "pkg:apps/web:dev",
    name: "dev",
    packageName: "@acme/web",
    packageDir: "apps/web",
    command: "cd 'apps/web' && pnpm run dev",
    packageManager: "pnpm",
  };

  it("takes a project and an optional thread, and answers with ready commands", () => {
    expect(rpc).toBeDefined();
    expect(RpcSchema.isStreamSchema(rpc!.successSchema)).toBe(false);
    const payload = Schema.decodeUnknownExit(rpc!.payloadSchema);
    expect(payload({ projectId })._tag).toBe("Success");
    expect(payload({})._tag).toBe("Failure");
    const success = Schema.decodeUnknownExit(rpc!.successSchema);
    expect(
      success([script, { ...script, id: "pkg::build", packageDir: "", packageName: null }]),
    ).toMatchObject({ _tag: "Success" });
  });

  it("refuses a detected script with no command or an unknown package manager", () => {
    const decode = Schema.decodeUnknownExit(DetectedScript);
    expect(decode(script)._tag).toBe("Success");
    expect(decode({ ...script, command: "" })._tag).toBe("Failure");
    expect(decode({ ...script, packageManager: "deno" })._tag).toBe("Failure");
  });
});
