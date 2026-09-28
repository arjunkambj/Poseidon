/**
 * `browser.discoverServers`: the local dev servers a thread's project is
 * running, for the browser pane's address suggestions and its empty state.
 *
 * The server is the only side that sees the machine (philosophy §8), and the
 * question is narrow: "which of this project's processes serve a web page on
 * this machine?" So the answer is built from three checks, each there for a
 * reason:
 *
 * 1. **Listeners.** `lsof -nP -iTCP -sTCP:LISTEN -F pcn` — every listening TCP
 *    socket with its pid and command, in `lsof`'s field format, never through
 *    a shell and never past 3 s. Only loopback and wildcard listeners count: a
 *    socket bound to one LAN address is not something `localhost` reaches.
 * 2. **Attribution.** `lsof -a -d cwd -p <pids> -Fn` gives each candidate's
 *    working directory, and a listener counts only when that directory is the
 *    project's folder or inside it. That is what keeps another project's dev
 *    server, a chat app's local port or the OS's AirPlay receiver (which holds
 *    `*:5000` on macOS) out of this project's suggestions.
 * 3. **A probe.** One `GET /` on the listener's own loopback address, 500 ms,
 *    eight at a time. Only an HTML answer or a redirect is kept, so a database,
 *    a language server or a debugger port is never offered as a page.
 *
 * Without `lsof` (Windows, or a Linux without it) there is nothing to
 * attribute a port with, and the fallback probes at most sixteen common dev
 * ports on `localhost` instead — never a range. Those answers carry no process
 * name, since nothing says whose they are.
 *
 * Nothing runs in the background: a scan happens when the pane asks, and an
 * answer is reused for 10 s per project folder so a popover opened on every
 * keystroke costs one scan.
 */

import { execFile } from "node:child_process";
import { access, realpath as fsRealpath } from "node:fs/promises";
import { request } from "node:http";
import * as nodePath from "node:path";

import type { ThreadId } from "@poseidon/contracts/ids";
import { DEV_SERVER_LIMIT, type DevServer } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { threadWorkspaceRoot } from "../orchestration/workspaceRoot";
import { ReadModelStore } from "../persistence/ReadModels";
import { DevServerDiscovery } from "../rpc/services";

/** How long one project's answer is reused. */
export const DISCOVERY_TTL_MS = 10_000;
/** How long `lsof` may take before the scan gives up on it. */
const LSOF_TIMEOUT_MS = 3_000;
/** How long one probe may take, connection to headers. */
const PROBE_TIMEOUT_MS = 500;
/** Probes in flight at once. */
const PROBE_CONCURRENCY = 8;

/**
 * The fallback's whole list: the ports the common dev servers default to
 * (Next, CRA, Vite and its preview, Angular, Astro, Rails, Django, webpack,
 * Wrangler, Live Server, Jupyter). Sixteen at most, so the fallback can never
 * become a port scan.
 */
export const FALLBACK_PORTS: ReadonlyArray<number> = [
  3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 5500, 8000, 8080, 8081, 8787, 8888,
];

/** One listening socket as `lsof -F pcn` reports it. */
export interface Listener {
  readonly pid: number;
  readonly command: string;
  /** As lsof prints it: `127.0.0.1`, `*`, `[::1]`, `192.168.1.4`. */
  readonly host: string;
  readonly port: number;
}

/**
 * `lsof -F pcn` output as listeners. The format is one field per line, each
 * led by its tag: `p` starts a process, `c` names it, `f` starts one of its
 * descriptors and `n` is that descriptor's address, `host:port`.
 */
export const parseListeners = (text: string): ReadonlyArray<Listener> => {
  const listeners: Array<Listener> = [];
  let pid: number | null = null;
  let command = "";
  for (const line of text.split("\n")) {
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      command = "";
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n" && pid !== null) {
      const colon = value.lastIndexOf(":");
      const port = Number.parseInt(value.slice(colon + 1), 10);
      if (colon > 0 && Number.isInteger(port) && port > 0 && port <= 65535) {
        listeners.push({ pid, command, host: value.slice(0, colon), port });
      }
    }
  }
  return listeners;
};

/** `lsof -a -d cwd -Fn` output as `pid -> working directory`. */
export const parseCwds = (text: string): ReadonlyMap<number, string> => {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    const tag = line.charAt(0);
    if (tag === "p") {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (tag === "n" && pid !== null && line.length > 1) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
};

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/**
 * The address to probe a listener on, or null when `localhost` cannot reach
 * it. A wildcard (`*`, `0.0.0.0`, `[::]`) answers on IPv4 loopback; `[::1]`
 * only on its own — which is where Vite lands on macOS, where `localhost`
 * resolves to IPv6 first.
 */
export const probeHostOf = (host: string): string | null => {
  if (host === "*" || host === "0.0.0.0" || host === "[::]" || host === "localhost") {
    return "127.0.0.1";
  }
  if (LOOPBACK_V4.test(host)) return host;
  if (host === "[::1]") return "::1";
  return null;
};

/** Whether `path` is `root` or somewhere inside it. */
export const isInside = (root: string, path: string): boolean => {
  const relative = nodePath.relative(root, path);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
};

/** What discovery needs from the machine; the tests replace every part. */
export interface DiscoverySystem {
  /** One `lsof` run's stdout, or null when there is no `lsof` to run. */
  readonly lsof: (args: ReadonlyArray<string>) => Effect.Effect<string | null>;
  /** Whether `host:port` answers `GET /` with a page or a redirect. */
  readonly probe: (host: string, port: number) => Effect.Effect<boolean>;
  /** The symlink-resolved path, or the path itself when it cannot be resolved. */
  readonly realpath: (path: string) => Effect.Effect<string>;
  /** Our own pid: the server's own port is never a suggestion. */
  readonly selfPid: number;
}

const serverAt = (port: number, processName: string | null): DevServer => ({
  url: `http://localhost:${port}`,
  port,
  processName: processName === null || processName === "" ? null : processName,
});

const byPort = (a: DevServer, b: DevServer) => a.port - b.port;

/** The bounded fallback: common dev ports on `localhost`, nothing else. */
const probeCommonPorts = (system: DiscoverySystem) =>
  Effect.forEach(
    FALLBACK_PORTS,
    (port) =>
      system.probe("localhost", port).pipe(Effect.map((ok) => (ok ? serverAt(port, null) : null))),
    { concurrency: PROBE_CONCURRENCY },
  ).pipe(Effect.map((found) => found.filter((server) => server !== null)));

/** The dev servers under `root`, sorted by port. */
export const discoverServers = (
  root: string,
  system: DiscoverySystem,
): Effect.Effect<ReadonlyArray<DevServer>> =>
  Effect.gen(function* () {
    const listing = yield* system.lsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
    if (listing === null) {
      return (yield* probeCommonPorts(system)).slice(0, DEV_SERVER_LIMIT);
    }
    const local = parseListeners(listing).filter(
      (listener) => listener.pid !== system.selfPid && probeHostOf(listener.host) !== null,
    );
    if (local.length === 0) return [];
    const pids = [...new Set(local.map((listener) => listener.pid))];
    const cwdText = yield* system.lsof(["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"]);
    if (cwdText === null) {
      return (yield* probeCommonPorts(system)).slice(0, DEV_SERVER_LIMIT);
    }
    const cwds = parseCwds(cwdText);
    const realRoot = yield* system.realpath(root);
    const inProject = (pid: number) => {
      const cwd = cwds.get(pid);
      return cwd !== undefined && (isInside(realRoot, cwd) || isInside(root, cwd));
    };
    // One candidate per port: a dual-stack server lists its port twice.
    const candidates = new Map<number, Listener>();
    for (const listener of local) {
      if (inProject(listener.pid) && !candidates.has(listener.port)) {
        candidates.set(listener.port, listener);
      }
    }
    const found = yield* Effect.forEach(
      [...candidates.values()],
      (listener) =>
        system
          .probe(probeHostOf(listener.host) ?? "127.0.0.1", listener.port)
          .pipe(Effect.map((ok) => (ok ? serverAt(listener.port, listener.command) : null))),
      { concurrency: PROBE_CONCURRENCY },
    );
    return found
      .filter((server) => server !== null)
      .sort(byPort)
      .slice(0, DEV_SERVER_LIMIT);
  });

/**
 * The per-thread entry point with its cache. `rootOf` resolves a thread to
 * its project's folder; a thread with none has nothing to attribute a server
 * to and gets an empty list.
 */
export const makeDevServerDiscovery = (
  system: DiscoverySystem,
  rootOf: (threadId: ThreadId) => Effect.Effect<string | null>,
) =>
  Effect.gen(function* () {
    const cache = yield* Ref.make(
      new Map<string, { readonly at: number; readonly servers: ReadonlyArray<DevServer> }>(),
    );
    const now = Effect.clockWith((clock) => clock.currentTimeMillis);

    const discover = (threadId: ThreadId): Effect.Effect<ReadonlyArray<DevServer>> =>
      Effect.gen(function* () {
        const root = yield* rootOf(threadId);
        if (root === null) return [];
        const at = yield* now;
        const cached = (yield* Ref.get(cache)).get(root);
        if (cached !== undefined && at - cached.at < DISCOVERY_TTL_MS) return cached.servers;
        const servers = yield* discoverServers(root, system);
        yield* Ref.update(cache, (current) => {
          const next = new Map(
            [...current].filter(([, entry]) => at - entry.at < DISCOVERY_TTL_MS),
          );
          next.set(root, { at, servers });
          return next;
        });
        return servers;
      });

    return { discover };
  });

// ── The machine ────────────────────────────────────────────────

/** Where `lsof` usually is; a server launched from the Dock has a short PATH. */
const LSOF_PATHS = ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"];

const findLsof = async (): Promise<string> => {
  for (const candidate of LSOF_PATHS) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not here; try the next one, then PATH.
    }
  }
  return "lsof";
};

let lsofPath: Promise<string> | null = null;
const lsofBinary = Effect.promise(() => (lsofPath ??= findLsof()));

/**
 * One `lsof` run. It exits 1 both when nothing matched and when one of the
 * pids asked about has since exited, and still prints the rest — so its
 * stdout is the answer whatever the exit code. Only a missing binary or a
 * run past the timeout means there is no answer.
 */
const runLsof =
  (binary: Effect.Effect<string>) =>
  (args: ReadonlyArray<string>): Effect.Effect<string | null> =>
    Effect.flatMap(binary, (bin) =>
      Effect.callback<string | null>((resume) => {
        const child = execFile(
          bin,
          [...args],
          { timeout: LSOF_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
          (error, stdout) => {
            const missing = error !== null && (error.code === "ENOENT" || error.code === "EACCES");
            resume(Effect.succeed(missing || error?.killed === true ? null : String(stdout)));
          },
        );
        return Effect.sync(() => child.kill("SIGKILL"));
      }),
    );

/**
 * `GET /` on `host:port`, bounded to `timeoutMs` from start to headers. A
 * page (`text/html`) or a redirect is a yes; anything else — another
 * protocol, a JSON API, a refusal, silence — is a no. The body is never read.
 */
export const probeHttp = (host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS) =>
  Effect.callback<boolean>((resume) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resume(Effect.succeed(ok));
    };
    const req = request(
      {
        host,
        port,
        path: "/",
        method: "GET",
        agent: false,
        headers: { host: `localhost:${port}`, accept: "text/html" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const type = String(response.headers["content-type"] ?? "").toLowerCase();
        settle((status >= 300 && status < 400) || type.startsWith("text/html"));
      },
    );
    const timer = setTimeout(() => settle(false), timeoutMs);
    req.on("error", () => settle(false));
    req.end();
    return Effect.sync(() => settle(false));
  });

/** The real machine. Exported for the test that runs the real `lsof` once. */
export const nodeSystem: DiscoverySystem = {
  lsof: runLsof(lsofBinary),
  probe: (host, port) => probeHttp(host, port),
  realpath: (path) => Effect.promise(() => fsRealpath(path).catch(() => path)),
  selfPid: process.pid,
};

/**
 * The directory a thread's dev servers run from: its worktree when it has
 * one, which lives outside the project folder, and the project's folder
 * otherwise (`threadWorkspaceRoot`). `null` for a thread or project that is
 * not there.
 */
export const threadRootOf =
  (readModels: Pick<ReadModelStore["Service"], "getThreadDoc" | "getProjectDoc">) =>
  (threadId: ThreadId): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const thread = yield* readModels.getThreadDoc(threadId);
      if (thread === null) return null;
      const project = yield* readModels.getProjectDoc(thread.projectId);
      return project === null ? null : threadWorkspaceRoot(thread, project);
    }).pipe(Effect.catch(() => Effect.succeed(null)));

/** @public The real `DevServerDiscovery`. Wired in `boot.ts`. */
export const layer = Layer.effect(
  DevServerDiscovery,
  Effect.gen(function* () {
    const readModels = yield* ReadModelStore;
    const discovery = yield* makeDevServerDiscovery(nodeSystem, threadRootOf(readModels));
    return DevServerDiscovery.of(discovery);
  }),
);
