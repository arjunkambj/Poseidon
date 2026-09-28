/**
 * Plumbing for the tests of the `sdk-stream` tee and replayer.
 *
 * Those tests exercise the transport mechanics — lines in both directions,
 * request ids, process groups, exit codes — so they need a process on the far
 * end of the pipes. It is an ordinary node program written into the test's temp
 * directory: it answers whatever it is sent in the transport's envelope and
 * knows nothing about any harness. Nothing it produces is ever written under
 * `fixtures/`; recordings of harnesses come only from the harnesses.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

/**
 * The program: `--version` and `auth status` print one line each; a run with
 * `stream-json` in its argv prints a `ready` line with its pid, then answers
 * each stdin line — a `control_request` with a `control_response` carrying its
 * id, a `user` message with a `receipt` naming its uuid when it has one and a
 * `can_use_tool` request of its own, the answer to
 * that with a `result` naming the behaviour, and anything else with an `echo` —
 * and exits 0 when stdin closes.
 */
const PROGRAM = `
import * as readline from "node:readline";
const argv = process.argv.slice(2);
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (argv.includes("--version")) {
  process.stdout.write("9.9.9 (counterpart)\\n");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  say({ loggedIn: true, email: "someone@example.org", orgName: "Example Org" });
  process.exit(0);
}
say({ type: "ready", pid: process.pid, cwd: process.cwd() });
let asked = 0;
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    say({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { subtype: message.request.subtype } } });
  } else if (message.type === "user") {
    if (message.uuid !== undefined) say({ type: "receipt", command_uuid: message.uuid });
    asked += 1;
    say({ type: "control_request", request_id: "asked-" + asked, request: { subtype: "can_use_tool", tool_name: "Anything" } });
  } else if (message.type === "control_response") {
    say({ type: "result", request_id: message.response.request_id, behavior: message.response.response.behavior });
  } else {
    say({ type: "echo", message });
  }
});
lines.on("close", () => process.exit(0));
`;

/** Writes the program into `dir` as an executable and returns its path. */
export const writeCounterpart = (dir: string): string => {
  const file = NodePath.join(dir, "counterpart.mjs");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(file, `#!${process.execPath}\n${PROGRAM}`, { mode: 0o755 });
  return file;
};

export interface Conversation {
  readonly child: ChildProcessWithoutNullStreams;
  /** Writes one NDJSON line. */
  readonly send: (message: unknown) => void;
  /** The next stdout line that satisfies `predicate`, parsed when it is JSON. */
  readonly awaitLine: (predicate?: (line: unknown) => boolean) => Promise<unknown>;
  /** Every stdout line so far, parsed. */
  readonly seen: () => ReadonlyArray<unknown>;
  /** Resolves when the process has exited and its pipes have closed. */
  readonly exited: Promise<{ code: number | null; signal: string | null; stderr: string }>;
}

/** Spawns `binary` with pipes and talks NDJSON to it. */
export const converse = (
  binary: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly detached?: boolean },
): Conversation => {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: options.detached ?? false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  const lines: Array<unknown> = [];
  interface Waiter {
    readonly predicate: (line: unknown) => boolean;
    readonly resolve: (line: unknown) => void;
    readonly reject: (error: Error) => void;
  }
  const waiters: Array<Waiter> = [];
  // Each await consumes from where the last one it answered left off.
  let read = 0;
  let closed = false;
  const settle = (): void => {
    for (const waiter of waiters.slice()) {
      const at = lines.findIndex((line, index) => index >= read && waiter.predicate(line));
      if (at !== -1) {
        waiters.splice(waiters.indexOf(waiter), 1);
        read = at + 1;
        waiter.resolve(lines[at]);
      } else if (closed) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.reject(new Error("stdout closed before the awaited line"));
      }
    }
  };
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      lines.push(JSON.parse(line));
    } catch {
      lines.push(line);
    }
    settle();
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: string | null; stderr: string }>(
    (resolve) => {
      child.once("close", (code, signal) => {
        closed = true;
        settle();
        resolve({ code, signal, stderr });
      });
    },
  );
  return {
    child,
    send: (message) => {
      child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    },
    awaitLine: (predicate = () => true) =>
      new Promise((resolve, reject) => {
        waiters.push({ predicate, resolve, reject });
        settle();
      }),
    seen: () => [...lines],
    exited,
  };
};

/**
 * Whether `pid` is a live process. A zombie awaiting its reaper is not, and
 * neither is one the kernel is already tearing down: `ps` flags it `E` ("trying
 * to exit") in the moment between a SIGKILL and the zombie, which a loaded
 * machine can stretch long enough to be seen.
 */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return stat !== "" && !stat.startsWith("Z") && !stat.includes("E");
  } catch {
    return false;
  }
};

/**
 * Whether `pid` is gone within `withinMs`. A group SIGKILL reaches each member
 * on its own schedule: the leader's exit can be seen before a busy machine has
 * taken down the rest of the group, so a check made at once can race it.
 */
export const pidGoneWithin = async (pid: number, withinMs: number): Promise<boolean> => {
  const deadline = Date.now() + withinMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
};
