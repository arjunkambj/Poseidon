/**
 * Starting the Claude Code CLI for the SDK, and proving it has stopped.
 *
 * The SDK spawns the CLI itself unless it is handed `spawnClaudeCodeProcess`,
 * and its own spawn leaves the child in the server's process group, where a
 * shell command the model started outlives the CLI that started it. So the
 * session hands it this instead: the SDK's command, argv, cwd and environment
 * — the environment being the default-deny one the session built, plus the
 * few entry-point variables the SDK adds for its own child — spawned
 * `detached`, so the CLI leads a process group of its own. Every signal goes
 * to the whole group (`kill(-pid)`), which is the only way a Bash tool's
 * grandchildren go with it.
 *
 * `close` is not best-effort. `stop` signals the group, waits for the leader,
 * escalates to SIGKILL after a grace period, sweeps whatever is left, and
 * `isGone` is the proof: signal 0 to the group fails with ESRCH once no
 * member is left.
 *
 * A group that is gone is never signalled again. Its id is free for the
 * kernel to hand out once no member is left, so a later `kill(-pid)` — or a
 * direct `kill(pid)` — could reach an unrelated process that now holds it.
 * While a member is left the id cannot be reused, so a group whose leader has
 * exited is still signalled for the members it left behind.
 *
 * The CLI's stderr is drained here — the SDK reads none from a custom spawn —
 * and its tail is kept, because an exit the session did not ask for is
 * explained by nothing else.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import * as Effect from "effect/Effect";

/** The part of the SDK's `SpawnOptions` this reads. */
export interface ClaudeSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** The SDK's `SpawnedProcess`, as this module provides it. */
export interface ClaudeSpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: ExitListener): void;
  on(event: "error", listener: ErrorListener): void;
  once(event: "exit", listener: ExitListener): void;
  once(event: "error", listener: ErrorListener): void;
  off(event: "exit", listener: ExitListener): void;
  off(event: "error", listener: ErrorListener): void;
}

/** How one spawned child ended. */
export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** One CLI child: its pid, how it ended, and its stderr's last lines. */
export interface ClaudeChild {
  readonly pid: number;
  /** Resolves on the child's 'exit', when its stderr may still hold lines. */
  readonly exited: Promise<ChildExit>;
  /**
   * Resolves once the child's stderr has ended, so `stderrTail` holds its
   * last line. A grandchild that inherited stderr keeps it open
   * past the child's exit, so a reader bounds the wait.
   */
  readonly drained: Promise<void>;
  readonly stderrTail: () => string;
}

/** The children one session or probe spawned, and the means to stop them. */
export interface ProcessGroup {
  /** What `Options.spawnClaudeCodeProcess` is set to. */
  readonly spawn: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess;
  /** The newest child, if one has been spawned. */
  readonly latest: () => ClaudeChild | undefined;
  /** Every child spawned so far. */
  readonly children: () => ReadonlyArray<ClaudeChild>;
  /** SIGTERM to every group, SIGKILL after the grace, then a sweep. */
  readonly stop: Effect.Effect<void>;
  /** True once no process of any group this spawned is left. */
  readonly isGone: Effect.Effect<boolean>;
}

/** How much of the child's stderr is kept, from the end. */
const STDERR_TAIL = 8 * 1024;
const KILL_GRACE = "5 seconds";
/** A `pgrep` that hangs must not hang the server with it. */
const PGREP_TIMEOUT_MS = 5_000;

/** One spawned child as the group tracks it. */
interface Member {
  readonly pid: number;
  /** The leader has exited and been reaped: its pid only names its group now. */
  readonly reaped: () => boolean;
  /** Latched once the group was seen gone: nothing is signalled after that. */
  gone: boolean;
}

/** The group was seen gone — now or before — and is latched so. */
const seenGone = (member: Member): boolean => {
  if (!member.gone && isGroupGone(member.pid)) member.gone = true;
  return member.gone;
};

/**
 * `kill(-pid)` reaches the group; a child that is not a group leader gets the
 * direct kill while it has not exited. A group already gone gets nothing, and
 * neither does a child that never started — `-(-1)` would be pid 1.
 */
const signalGroup = (member: Member, signal: NodeJS.Signals): boolean => {
  if (member.pid <= 0 || seenGone(member)) return false;
  try {
    process.kill(-member.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      member.gone = true;
      return false;
    }
    if (member.reaped()) return false;
    try {
      process.kill(member.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
};

/** No member of `pid`'s group is left: signal 0 to the group fails with ESRCH. */
export const isGroupGone = (pid: number): boolean => {
  if (pid <= 0) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/**
 * Whatever is still in the group after the leader died gets a direct SIGKILL.
 * `pgrep -g` lists group members on Linux and macOS; where it does not exist
 * the sweep does nothing, and `isGone` still reports the truth.
 */
const sweepGroup = (pid: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const child = execFile(
      "pgrep",
      ["-g", String(pid)],
      { encoding: "utf8", timeout: PGREP_TIMEOUT_MS, killSignal: "SIGKILL" },
      (_error, stdout) => {
        for (const line of String(stdout).split("\n")) {
          const member = Number.parseInt(line.trim(), 10);
          if (Number.isFinite(member) && member > 0) {
            try {
              process.kill(member, "SIGKILL");
            } catch {
              // raced us to exit
            }
          }
        }
        resume(Effect.void);
      },
    );
    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  });

/** The SDK's view of the child, with every signal sent to the group. */
const asSpawned = (child: ChildProcess, member: Member): ClaudeSpawnedProcess => ({
  stdin: child.stdin!,
  stdout: child.stdout!,
  get killed() {
    return child.killed;
  },
  get exitCode() {
    return child.exitCode;
  },
  get signalCode() {
    return child.signalCode;
  },
  kill: (signal) => signalGroup(member, signal),
  on: (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
    child.on(event, listener);
  },
  once: (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
    child.once(event, listener);
  },
  off: (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
    child.off(event, listener);
  },
});

export const makeProcessGroup = (hooks?: {
  /** Each chunk of the child's stderr, for the session's log. */
  readonly onStderr?: (chunk: string) => void;
}): ProcessGroup => {
  const spawned: Array<ClaudeChild & { readonly member: Member }> = [];

  const spawnOne = (options: ClaudeSpawnOptions): ClaudeSpawnedProcess => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env)) {
      if (value !== undefined) env[name] = value;
    }
    const child = spawn(options.command, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A spawn that fails (ENOENT) has no pid; the SDK learns of it through the
    // 'error' event on the process it is handed, which reports it as a failed
    // launch naming the path.
    const pid = child.pid ?? -1;
    const member: Member = {
      pid,
      reaped: () => child.exitCode !== null || child.signalCode !== null,
      gone: pid <= 0,
    };
    let tail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL);
      hooks?.onStderr?.(chunk);
    });
    const exited = new Promise<ChildExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: child.exitCode, signal: child.signalCode }));
    });
    // Its own stream's end, not the child's 'close', which also waits on a
    // stdout nobody may be reading any more.
    const drained = new Promise<void>((resolve) => {
      if (child.stderr === null) {
        void exited.then(() => resolve());
        return;
      }
      child.stderr.once("end", () => resolve());
      child.stderr.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    if (pid > 0) {
      spawned.push({ pid, exited, drained, stderrTail: () => tail, member });
    }
    options.signal?.addEventListener("abort", () => signalGroup(member, "SIGTERM"), {
      once: true,
    });
    return asSpawned(child, member);
  };

  const stopOne = (child: (typeof spawned)[number]): Effect.Effect<void> =>
    Effect.gen(function* () {
      signalGroup(child.member, "SIGTERM");
      const settled = yield* Effect.raceFirst(
        Effect.promise(() => child.exited).pipe(Effect.as(true)),
        Effect.sleep(KILL_GRACE).pipe(Effect.as(false)),
      );
      if (!settled) signalGroup(child.member, "SIGKILL");
      yield* Effect.promise(() => child.exited);
      if (!seenGone(child.member)) yield* sweepGroup(child.pid);
    });

  return {
    spawn: spawnOne,
    latest: () => spawned.at(-1),
    children: () =>
      spawned.map(({ pid, exited, drained, stderrTail }) => ({ pid, exited, drained, stderrTail })),
    stop: Effect.suspend(() =>
      Effect.forEach([...spawned], stopOne, { discard: true, concurrency: "unbounded" }),
    ),
    isGone: Effect.sync(() => spawned.every((child) => seenGone(child.member))),
  };
};
