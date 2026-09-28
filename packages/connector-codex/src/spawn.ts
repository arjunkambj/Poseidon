/**
 * Starting `codex` children, and proving they have stopped.
 *
 * Every child is spawned `detached`, so it leads a process group of its own,
 * and every signal goes to the whole group (`kill(-pid)`): a shell command the
 * model started is a grandchild of the app-server, and signalling the group is
 * the only way it goes with its parent rather than outliving it in the
 * server's own group.
 *
 * `stop` is not best-effort. It first closes the child's stdin — the
 * app-server's stdio transport ends the process on EOF, cleanly, with exit 0 —
 * then signals the group with SIGTERM if the leader has not gone within a
 * grace, escalates to SIGKILL after another, and sweeps whatever members are
 * left. `isGone` is the proof: signal 0 to the group fails with ESRCH once no
 * member is left.
 *
 * A group that is gone is never signalled again. Its id is free for the
 * kernel to hand out once no member is left, so a later `kill(-pid)` — or a
 * direct `kill(pid)` — could reach an unrelated process that now holds it.
 * While a member is left the id cannot be reused, so a group whose leader has
 * exited is still signalled for the members it left behind.
 *
 * The child's stderr is drained here and its tail kept, because an exit the
 * session did not ask for is explained by nothing else.
 */

import { execFile, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export interface CodexSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** The whole environment of the child: nothing is inherited beside it. */
  readonly env: Readonly<Record<string, string>>;
}

/** How one spawned child ended. `error` is set when it never started (ENOENT). */
export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

/** One `codex` child: its pipes, how it ended, and its stderr's last lines. */
export interface CodexChild {
  /** -1 for a child that never started. */
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly exited: Promise<ChildExit>;
  readonly stderrTail: () => string;
}

/** The children one session or probe spawned, and the means to stop them. */
export interface ProcessGroup {
  readonly spawn: (options: CodexSpawnOptions) => CodexChild;
  /** Every child spawned so far. */
  readonly children: () => ReadonlyArray<CodexChild>;
  /** stdin closed, SIGTERM after a grace, SIGKILL after another, then a sweep. */
  readonly stop: Effect.Effect<void>;
  /** True once no process of any group this spawned is left. */
  readonly isGone: Effect.Effect<boolean>;
}

/** How much of the child's stderr is kept, from the end. */
const STDERR_TAIL = 8 * 1024;
/** How long a child has to leave on its own once its stdin is closed. */
const CLOSE_GRACE: Duration.Input = "2 seconds";
const KILL_GRACE: Duration.Input = "5 seconds";
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
const signalGroup = (member: Member, signal: NodeJS.Signals): void => {
  if (member.pid <= 0 || seenGone(member)) return;
  try {
    process.kill(-member.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      member.gone = true;
      return;
    }
    if (member.reaped()) return;
    try {
      process.kill(member.pid, signal);
    } catch {
      // raced us to exit
    }
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

/** Settles true when `exited` does within `grace`, false otherwise. */
const exitsWithin = (exited: Promise<ChildExit>, grace: Duration.Input): Effect.Effect<boolean> =>
  Effect.raceFirst(
    Effect.promise(() => exited).pipe(Effect.as(true)),
    Effect.sleep(grace).pipe(Effect.as(false)),
  );

export const makeProcessGroup = (hooks?: {
  /** Each chunk of the child's stderr, for the session's log. */
  readonly onStderr?: (chunk: string) => void;
}): ProcessGroup => {
  const spawned: Array<CodexChild & { readonly member: Member }> = [];

  const spawnOne = (options: CodexSpawnOptions): CodexChild => {
    const child = spawn(options.command, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...options.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = child.pid ?? -1;
    const member: Member = {
      pid,
      reaped: () => child.exitCode !== null || child.signalCode !== null,
      gone: pid <= 0,
    };
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL);
      hooks?.onStderr?.(chunk);
    });
    // A write to a child that has gone fails with EPIPE; the exit says why.
    child.stdin.on("error", () => {});
    const exited = new Promise<ChildExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) =>
        resolve({ code: child.exitCode, signal: child.signalCode, error: error.message }),
      );
    });
    const spawnedChild = {
      pid,
      stdin: child.stdin,
      stdout: child.stdout,
      exited,
      stderrTail: () => tail,
      member,
    };
    spawned.push(spawnedChild);
    return spawnedChild;
  };

  const stopOne = (child: (typeof spawned)[number]): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (child.pid <= 0) return;
      if (!child.member.reaped()) {
        child.stdin.end();
        if (!(yield* exitsWithin(child.exited, CLOSE_GRACE))) {
          signalGroup(child.member, "SIGTERM");
          if (!(yield* exitsWithin(child.exited, KILL_GRACE))) {
            signalGroup(child.member, "SIGKILL");
          }
        }
        yield* Effect.promise(() => child.exited);
      }
      if (!seenGone(child.member)) {
        signalGroup(child.member, "SIGKILL");
        yield* sweepGroup(child.pid);
      }
    });

  return {
    spawn: spawnOne,
    children: () =>
      spawned.map(({ pid, stdin, stdout, exited, stderrTail }) => ({
        pid,
        stdin,
        stdout,
        exited,
        stderrTail,
      })),
    stop: Effect.suspend(() =>
      Effect.forEach([...spawned], stopOne, { discard: true, concurrency: "unbounded" }),
    ),
    isGone: Effect.sync(() => spawned.every((child) => seenGone(child.member))),
  };
};
