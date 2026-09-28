/**
 * Dev-server discovery. The `lsof` answers are a real capture from this
 * machine (`./test/discovery/`, with its manifest): four servers started for
 * it — an HTML page and a redirect under the project, a non-HTTP listener
 * under the project, and an HTML page outside it — among everything else that
 * was listening at the time. The probe runs against real local sockets.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";

import { describe, expect, it } from "@effect/vitest";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import { DEV_SERVER_LIMIT } from "@poseidon/contracts/rpc";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { ProjectDoc, ThreadDoc } from "../orchestration/state";
import {
  DISCOVERY_TTL_MS,
  discoverServers,
  FALLBACK_PORTS,
  isInside,
  makeDevServerDiscovery,
  nodeSystem,
  parseCwds,
  parseListeners,
  probeHostOf,
  probeHttp,
  threadRootOf,
  type DiscoverySystem,
} from "./discovery";

const fixture = (name: string) =>
  readFileSync(new URL(`./test/discovery/${name}`, import.meta.url), "utf8");

const LISTEN = fixture("lsof-listen.txt");
const CWD = fixture("lsof-cwd.txt");
interface Started {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  readonly answer: string;
}
const MANIFEST = JSON.parse(fixture("manifest.json")) as {
  readonly project: string;
  readonly started: Readonly<Record<"html" | "redirect" | "raw" | "outside", Started>>;
};
const { html, redirect, raw, outside } = MANIFEST.started;

/** What each recorded server answered `curl` with, as the probe's yes or no. */
const recordedAnswer = (port: number): boolean =>
  Object.values(MANIFEST.started).some(
    (server) => server.port === port && /^(200 text\/html|3\d\d)/.test(server.answer),
  );

interface Calls {
  readonly lsof: Array<ReadonlyArray<string>>;
  readonly probes: Array<string>;
}

/** The recorded machine: `lsof` answers from the capture, the probe from the manifest. */
const recordedSystem = (overrides: Partial<DiscoverySystem> = {}) => {
  const calls: Calls = { lsof: [], probes: [] };
  const system: DiscoverySystem = {
    lsof: (args) =>
      Effect.sync(() => {
        calls.lsof.push(args);
        return args.includes("cwd") ? CWD : LISTEN;
      }),
    probe: (host, port) =>
      Effect.sync(() => {
        calls.probes.push(`${host}:${port}`);
        return recordedAnswer(port);
      }),
    realpath: (path) => Effect.succeed(path),
    selfPid: 1,
    ...overrides,
  };
  return { system, calls };
};

describe("parsing lsof", () => {
  it("reads every listener with its process, host and port", () => {
    const listeners = parseListeners(LISTEN);
    const find = (port: number) => listeners.find((listener) => listener.port === port);
    expect(find(html.port)).toEqual({
      pid: html.pid,
      command: "node",
      host: "127.0.0.1",
      port: html.port,
    });
    expect(find(redirect.port)).toEqual({
      pid: redirect.pid,
      command: "node",
      host: "[::1]",
      port: redirect.port,
    });
    expect(find(outside.port)?.host).toBe("*");
    // A process with several descriptors keeps its name on each.
    expect(listeners.filter((listener) => listener.command === "ControlCenter").length).toBe(4);
    // A name with spaces and parentheses survives whole.
    expect(listeners.some((listener) => listener.command === "Discord Helper (Renderer)")).toBe(
      true,
    );
  });

  it("reads each process's working directory", () => {
    const cwds = parseCwds(CWD);
    expect(cwds.get(html.pid)).toBe(`${MANIFEST.project}/apps/web`);
    expect(cwds.get(raw.pid)).toBe(MANIFEST.project);
    expect(cwds.get(outside.pid)).toBe("<SCRATCH>/other");
    expect(cwds.get(671)).toBe("/");
  });

  it("ignores lines that are not fields it knows", () => {
    expect(
      parseListeners("garbage\nn127.0.0.1:80\np12\ncnode\nnnot-an-address\nn[::1]:0\n"),
    ).toEqual([]);
    expect(parseCwds("n/orphan\npx\nn/also-orphan\n").size).toBe(0);
  });
});

describe("which listeners count", () => {
  it("probes loopback and wildcard listeners on an address localhost reaches", () => {
    expect(probeHostOf("127.0.0.1")).toBe("127.0.0.1");
    expect(probeHostOf("127.0.1.1")).toBe("127.0.1.1");
    expect(probeHostOf("*")).toBe("127.0.0.1");
    expect(probeHostOf("0.0.0.0")).toBe("127.0.0.1");
    expect(probeHostOf("[::]")).toBe("127.0.0.1");
    expect(probeHostOf("[::1]")).toBe("::1");
    expect(probeHostOf("192.168.1.4")).toBeNull();
    expect(probeHostOf("[fe80::1]")).toBeNull();
  });

  it("counts the project folder and what is under it, never a sibling that shares a prefix", () => {
    expect(isInside("/work/app", "/work/app")).toBe(true);
    expect(isInside("/work/app", "/work/app/packages/web")).toBe(true);
    expect(isInside("/work/app", "/work/app-other")).toBe(false);
    expect(isInside("/work/app", "/work")).toBe(false);
    expect(isInside("/work/app", "/")).toBe(false);
  });
});

describe("discoverServers", () => {
  it.effect("keeps only the project's processes, then only those that serve a page", () =>
    Effect.gen(function* () {
      const { system, calls } = recordedSystem();
      const servers = yield* discoverServers(MANIFEST.project, system);
      // The outside server is never probed; the non-HTTP one is, and fails it.
      expect([...calls.probes].sort()).toEqual(
        [`127.0.0.1:${html.port}`, `::1:${redirect.port}`, `127.0.0.1:${raw.port}`].sort(),
      );
      expect(servers).toEqual(
        [
          { url: `http://localhost:${html.port}`, port: html.port, processName: "node" },
          { url: `http://localhost:${redirect.port}`, port: redirect.port, processName: "node" },
        ].sort((a, b) => a.port - b.port),
      );
      // One listing, then one cwd lookup for the local listeners' pids only.
      expect(calls.lsof[0]).toEqual(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
      const pids = calls.lsof[1]![calls.lsof[1]!.indexOf("-p") + 1]!.split(",");
      expect(pids).toContain(String(html.pid));
      expect(new Set(pids).size).toBe(pids.length);
    }),
  );

  it.effect("matches a project named through a symlink by its real path", () =>
    Effect.gen(function* () {
      const { system } = recordedSystem({
        realpath: (path) => Effect.succeed(path === "/link/project" ? MANIFEST.project : path),
      });
      const servers = yield* discoverServers("/link/project", system);
      expect(servers.map((server) => server.port)).toContain(html.port);
    }),
  );

  it.effect("finds nothing for a folder no listener runs in", () =>
    Effect.gen(function* () {
      const { system, calls } = recordedSystem();
      expect(yield* discoverServers("/nowhere/project", system)).toEqual([]);
      expect(calls.probes).toEqual([]);
    }),
  );

  it.effect("never offers the server's own port", () =>
    Effect.gen(function* () {
      const { system, calls } = recordedSystem({ selfPid: html.pid });
      const servers = yield* discoverServers(MANIFEST.project, system);
      expect(servers.map((server) => server.port)).not.toContain(html.port);
      expect(calls.probes).not.toContain(`127.0.0.1:${html.port}`);
    }),
  );

  it.effect("without lsof, probes the bounded list of common ports and nothing else", () =>
    Effect.gen(function* () {
      const { system, calls } = recordedSystem({
        lsof: () => Effect.succeed(null),
        probe: (host, port) =>
          Effect.sync(() => {
            calls.probes.push(`${host}:${port}`);
            return port === 5173 || port === 3000;
          }),
      });
      const servers = yield* discoverServers(MANIFEST.project, system);
      expect(FALLBACK_PORTS.length).toBeLessThanOrEqual(16);
      expect(calls.probes).toEqual(FALLBACK_PORTS.map((port) => `localhost:${port}`));
      expect(servers).toEqual([
        { url: "http://localhost:3000", port: 3000, processName: null },
        { url: "http://localhost:5173", port: 5173, processName: null },
      ]);
    }),
  );

  it.effect("falls back the same way when the cwd lookup has no answer", () =>
    Effect.gen(function* () {
      const { system, calls } = recordedSystem({
        lsof: (args) => Effect.succeed(args.includes("cwd") ? null : LISTEN),
      });
      yield* discoverServers(MANIFEST.project, system);
      expect(calls.probes).toEqual(FALLBACK_PORTS.map((port) => `localhost:${port}`));
    }),
  );

  it.effect("answers at most DEV_SERVER_LIMIT servers", () =>
    Effect.gen(function* () {
      const many = Array.from(
        { length: 40 },
        (_, i) => `p${100 + i}\ncnode\nf1\nn127.0.0.1:${4000 + i}\n`,
      ).join("");
      const cwds = Array.from({ length: 40 }, (_, i) => `p${100 + i}\nfcwd\nn/p\n`).join("");
      const { system } = recordedSystem({
        lsof: (args) => Effect.succeed(args.includes("cwd") ? cwds : many),
        probe: () => Effect.succeed(true),
      });
      const servers = yield* discoverServers("/p", system);
      expect(servers.length).toBe(DEV_SERVER_LIMIT);
      expect(servers[0]!.port).toBe(4000);
    }),
  );
});

describe("the per-thread cache", () => {
  const threadA = "0190aaaa-0000-7000-8000-00000000000a" as ThreadId;
  const threadB = "0190aaaa-0000-7000-8000-00000000000b" as ThreadId;

  it.effect("reuses one project's answer for the TTL, then scans again", () =>
    Effect.gen(function* () {
      const { system, calls } = recordedSystem();
      const discovery = yield* makeDevServerDiscovery(system, (threadId) =>
        Effect.succeed(threadId === threadA || threadId === threadB ? MANIFEST.project : null),
      );
      const first = yield* discovery.discover(threadA);
      yield* discovery.discover(threadB);
      expect(calls.lsof.length).toBe(2);
      yield* TestClock.adjust(Duration.millis(DISCOVERY_TTL_MS - 1));
      expect(yield* discovery.discover(threadA)).toEqual(first);
      expect(calls.lsof.length).toBe(2);
      yield* TestClock.adjust(Duration.millis(1));
      yield* discovery.discover(threadA);
      expect(calls.lsof.length).toBe(4);
    }),
  );

  it.effect("answers a thread with no project with nothing, and scans nothing", () =>
    Effect.gen(function* () {
      const { system, calls } = recordedSystem();
      const discovery = yield* makeDevServerDiscovery(system, () => Effect.succeed(null));
      expect(yield* discovery.discover(threadA)).toEqual([]);
      expect(calls.lsof).toEqual([]);
    }),
  );
});

// ── The probe, against real sockets ────────────────────────────

/**
 * A server on a free loopback port for the scope. Its sockets are destroyed on
 * the way out: a test server that never reads its socket never sees the
 * probe's hang-up, and `close` would wait for it forever.
 */
const listen = (server: Server | HttpServer, host = "127.0.0.1") =>
  Effect.suspend(() => {
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    return Effect.acquireRelease(
      Effect.callback<number>((resume) => {
        server.listen(0, host, () =>
          resume(Effect.succeed((server.address() as AddressInfo).port)),
        );
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          for (const socket of sockets) socket.destroy();
        }),
    );
  });

describe("threadRootOf", () => {
  const projectId = "p-1" as ProjectId;
  const project = { workspaceRoot: "/code/app" } as ProjectDoc;
  const readModels = (thread: Partial<ThreadDoc> | null) => ({
    getThreadDoc: () =>
      Effect.succeed(thread === null ? null : ({ projectId, ...thread } as ThreadDoc)),
    getProjectDoc: () => Effect.succeed(project),
  });

  it.effect("looks in a worktree thread's own worktree, not the project folder", () =>
    Effect.gen(function* () {
      const worktree = { path: "/home/me/.poseidon/worktrees/app/fix-login" };
      const root = yield* threadRootOf(readModels({ worktree } as Partial<ThreadDoc>))(
        "t-1" as ThreadId,
      );
      expect(root).toBe("/home/me/.poseidon/worktrees/app/fix-login");
    }),
  );

  it.effect("looks in the project folder for a local thread, and nowhere for a missing one", () =>
    Effect.gen(function* () {
      expect(yield* threadRootOf(readModels({ worktree: null }))("t-1" as ThreadId)).toBe(
        "/code/app",
      );
      expect(yield* threadRootOf(readModels(null))("t-1" as ThreadId)).toBeNull();
    }),
  );
});

describe("probeHttp", () => {
  it.live("says yes to a page and a redirect, no to JSON, another protocol and silence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const page = yield* listen(
          createHttpServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<!doctype html><title>dev</title>");
          }),
        );
        const moved = yield* listen(
          createHttpServer((_req, res) => {
            res.writeHead(302, { location: "/app/" });
            res.end();
          }),
        );
        const api = yield* listen(
          createHttpServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          }),
        );
        const smtp = yield* listen(createNetServer((socket) => socket.end("220 not http\r\n")));
        const silent = yield* listen(createNetServer(() => undefined));
        const answers = yield* Effect.all(
          [page, moved, api, smtp, silent].map((port) => probeHttp("127.0.0.1", port, 300)),
          { concurrency: "unbounded" },
        );
        expect(answers).toEqual([true, true, false, false, false]);
      }),
    ),
  );

  it.live("answers no to a port nobody listens on", () =>
    Effect.gen(function* () {
      const port = yield* Effect.scoped(listen(createNetServer()));
      expect(yield* probeHttp("127.0.0.1", port, 300)).toBe(false);
    }),
  );
});

describe("on this machine", () => {
  const hasLsof = ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"].some((path) => existsSync(path));

  it.live.skipIf(!hasLsof)(
    "finds a page this process serves, attributed by the real lsof to its folder",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const page = yield* listen(
            createHttpServer((_req, res) => {
              res.writeHead(200, { "content-type": "text/html" });
              res.end("<title>here</title>");
            }),
          );
          const api = yield* listen(createNetServer((socket) => socket.end("nope\r\n")));
          // The server's own pid is left out in production; here it is the
          // process under test, so nothing is.
          const system = { ...nodeSystem, selfPid: -1 };
          const here = yield* discoverServers(process.cwd(), system);
          expect(here.map((server) => server.port)).toContain(page);
          expect(here.map((server) => server.port)).not.toContain(api);
          expect(here.find((server) => server.port === page)?.processName).toMatch(/node/i);
          const elsewhere = yield* discoverServers("/nonexistent-poseidon-project", system);
          expect(elsewhere.map((server) => server.port)).not.toContain(page);
        }),
      ),
    10_000,
  );
});
