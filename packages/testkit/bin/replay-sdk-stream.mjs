#!/usr/bin/env node
/**
 * Replays a recorded `sdk-stream` harness as if it were the CLI.
 *
 * This has no behaviour of its own. Everything it emits was captured from the
 * real CLI by `bin/stdio-tee.mjs` and finalised into
 * `packages/testkit/fixtures/<kind>/<scenario>/`. It chooses nothing,
 * synthesises nothing, and answers no question the recording does not already
 * answer — a test that needs a different outcome names a different recording.
 *
 * It is launched by the launcher `sdkStreamReplayer(kind).config` writes:
 *
 *     node replay-sdk-stream.mjs <config.json> <the argv the SDK passed>
 *
 * `config.json` names the scenario directory, the invocation counter's state
 * file and, optionally, a directory to drop a pid file into and a file to
 * append divergences to.
 *
 * Each launch takes the first unplayed invocation whose argv is of the same
 * class — `--version`, `auth status`, a probe's stream-json handshake (a run
 * that keeps no session: `--no-session-persistence`), a session's stream-json
 * run, or else the exact argv. A probe that asks twice — a handshake included —
 * hears the last recorded answer again, because how often a server probes is
 * its own business; a session with no recorded run left to play is a
 * divergence.
 *
 * A simple invocation prints its recorded stdout and stderr and exits with its
 * recorded code. A stream run walks its frames in order:
 *
 *   - a frame from the harness is written to its channel;
 *   - at a frame to the harness, the replay blocks on the next line of stdin and
 *     checks it is the same move: the same `type`; for a `control_request` the
 *     same `request.subtype`; for a `control_response` the same
 *     `response.subtype`, and when it answers a request the harness made, the
 *     same `request_id` — plus the same `behavior` for `can_use_tool` and the
 *     same `permissionDecision` for `hook_callback`. Answers to two open harness
 *     requests may arrive in either order, and so may a user message and the
 *     answer to an open harness request — a message steered into a running
 *     turn races the SDK answering the CLI's hook — each still checked in its
 *     recorded place; nothing else may cross;
 *   - the SDK's own request ids are random, so each recorded one is mapped to the
 *     live one at the moment it arrives, and the recorded `control_response`s
 *     to it are rewritten to carry the live id;
 *   - the uuid the SDK's caller stamps on each user message is its own too, and
 *     the CLI names the message by it afterwards (its `command_lifecycle`
 *     receipts), so each recorded one is mapped to the live one when the
 *     message arrives, and every later harness frame carries the live uuid
 *     wherever the recorded one stood;
 *   - after the last frame it waits for stdin to close, then leaves the way the
 *     recorded run left, by exit code or by signal.
 *
 * Divergence is loud: anything the live side says that the recording did not,
 * or stdin closing while the recording still expects input, prints both sides
 * to stderr — and appends them to the config's `divergenceLog` when it names
 * one, for a test whose connector swallows the child's stderr — and exits 97. A recording made under one answer never plays out a
 * run that answered differently.
 *
 * `<HOME>`, `<SCRATCH>` and `<TMP>` in the recording are put back from this
 * process's own directories: its HOME, the parent of its working directory,
 * and its temp directory.
 *
 * Plain node, no dependencies, never imported by the server bundle.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const DIVERGED = 97;

const [configPath, ...argv] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(config.scenarioDir, "manifest.json"), "utf8"),
);
const label = `${manifest.kind}/${manifest.scenario}`;

const drained = (stream) => new Promise((resolve) => stream.write("", resolve));

const fail = async (message) => {
  const said = `replay-sdk-stream: ${label}: ${message}\n`;
  if (config.divergenceLog !== undefined) fs.appendFileSync(config.divergenceLog, said, "utf8");
  process.stderr.write(said);
  await drained(process.stderr);
  process.exit(DIVERGED);
};

if (config.pidDir !== undefined) {
  fs.mkdirSync(config.pidDir, { recursive: true });
  fs.writeFileSync(path.join(config.pidDir, String(process.pid)), "", "utf8");
}

// ── which recorded invocation this launch is ───────────────────

const classOf = (args) => {
  if (args.includes("--version") || args.includes("-v")) return "version";
  if (args[0] === "auth" && args[1] === "status") return "auth-status";
  if (args.includes("stream-json")) {
    return args.includes("--no-session-persistence") ? "probe-stream" : "stream";
  }
  return `argv:${JSON.stringify(args)}`;
};

/** Holds the counter's lock for the length of `body`; launches can race. */
const withLock = (body) => {
  const lock = `${config.stateFile}.lock`;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try {
    return body();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

const wanted = classOf(argv);
const streaming = wanted === "stream" || wanted === "probe-stream";
const chosen = withLock(() => {
  let played = [];
  try {
    played = JSON.parse(fs.readFileSync(config.stateFile, "utf8")).played ?? [];
  } catch {
    // The first launch of this scenario.
  }
  const candidates = manifest.invocations
    .map((invocation, index) => ({ invocation, index }))
    .filter(({ invocation }) => classOf(invocation.argv) === wanted);
  const next = candidates.find(({ index }) => !played.includes(index));
  const pick = next ?? (wanted === "stream" ? undefined : candidates.at(-1));
  if (pick !== undefined && next !== undefined) {
    fs.writeFileSync(config.stateFile, JSON.stringify({ played: [...played, pick.index] }), "utf8");
  }
  return pick;
});
if (chosen === undefined) {
  await fail(`no recorded invocation left to play for ${JSON.stringify(argv)}`);
}
const { invocation, index: invocationIndex } = chosen;

// ── the recording, with this machine's directories put back ────

const home = process.env.HOME ?? os.homedir();
const scratch = path.dirname(process.cwd());
const tmp = os.tmpdir();
const inJson = (text) => JSON.stringify(text).slice(1, -1);
const unscrub = (line) =>
  line
    .split("<HOME>")
    .join(inJson(home))
    .split("<SCRATCH>")
    .join(inJson(scratch))
    .split("<TMP>")
    .join(inJson(tmp));

const frames = fs
  .readFileSync(path.join(config.scenarioDir, invocation.file), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(unscrub(line)));

const lineOf = (data) => `${typeof data === "string" ? data : JSON.stringify(data)}\n`;

const write = (channel, data) =>
  new Promise((resolve) =>
    (channel === "stderr" ? process.stderr : process.stdout).write(lineOf(data), resolve),
  );

/** Leaves the way the recorded run left. */
const leave = async () => {
  await drained(process.stdout);
  await drained(process.stderr);
  if (invocation.signal !== null && invocation.signal !== undefined) {
    process.kill(process.pid, invocation.signal);
    // A signal whose default is not to terminate still ends the replay.
    setTimeout(() => process.exit(128), 1000);
    await new Promise(() => {});
  }
  process.exit(invocation.exitCode ?? 0);
};

if (!streaming) {
  for (const frame of frames) {
    if (frame.dir === "from-harness") await write(frame.channel, frame.data);
  }
  await leave();
}

// ── stdin, a line at a time ────────────────────────────────────

const pending = [];
let stdinClosed = false;
let wake = null;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  pending.push(line);
  wake?.();
});
lines.on("close", () => {
  stdinClosed = true;
  wake?.();
});

/** The next live line, parsed when it is JSON; null once stdin has closed. */
const nextLive = async () => {
  while (pending.length === 0) {
    if (stdinClosed) return null;
    await new Promise((resolve) => {
      wake = resolve;
    });
    wake = null;
  }
  const line = pending.shift();
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

// ── the walk ───────────────────────────────────────────────────

/** Requests the harness made, by recorded id → subtype. */
const harnessRequests = new Map();
const answered = new Set();
/** Answers that arrived ahead of an earlier open request's answer, or of a user message. */
const early = new Map();
/** User messages that arrived while an open request's answer was awaited. */
const earlyUsers = [];
/** The SDK's own request ids: recorded → live. */
const liveIds = new Map();
/** The user messages' uuids: recorded → live. */
const liveUuids = new Map();

const isObject = (value) => value !== null && typeof value === "object";
const answerId = (data) =>
  isObject(data) && data.type === "control_response" ? data.response?.request_id : undefined;
const isUser = (data) => isObject(data) && data.type === "user";

/** Why `live` is not the move `recorded` was, or null when it is. */
const mismatch = (recorded, live) => {
  if (!isObject(recorded)) return live === recorded ? null : "a different line";
  if (!isObject(live)) return "not a JSON object";
  if (live.type !== recorded.type) return "a different type";
  if (recorded.type === "control_request" && live.request?.subtype !== recorded.request?.subtype) {
    return "a different control request";
  }
  if (recorded.type !== "control_response") return null;
  if (live.response?.subtype !== recorded.response?.subtype) return "a different response subtype";
  const id = recorded.response?.request_id;
  if (!harnessRequests.has(id)) return null;
  if (live.response?.request_id !== id) return "an answer to a different request";
  const said = (data) => data.response?.response;
  switch (harnessRequests.get(id)) {
    case "can_use_tool":
      return said(live)?.behavior === said(recorded)?.behavior ? null : "a different behavior";
    case "hook_callback":
      return said(live)?.hookSpecificOutput?.permissionDecision ===
        said(recorded)?.hookSpecificOutput?.permissionDecision
        ? null
        : "a different permissionDecision";
    default:
      return null;
  }
};

/** The live line that should be `recorded`, holding back what arrived early. */
const takeLive = async (recorded) => {
  const awaited = harnessRequests.has(answerId(recorded)) ? answerId(recorded) : undefined;
  if (awaited !== undefined && early.has(awaited)) {
    const live = early.get(awaited);
    early.delete(awaited);
    return live;
  }
  if (isUser(recorded) && earlyUsers.length > 0) return earlyUsers.shift();
  for (;;) {
    const live = await nextLive();
    const id = answerId(live);
    const openAnswer = harnessRequests.has(id) && !answered.has(id) && !early.has(id);
    if (openAnswer && id !== awaited && (awaited !== undefined || isUser(recorded))) {
      early.set(id, live);
    } else if (awaited !== undefined && isUser(live)) {
      earlyUsers.push(live);
    } else {
      return live;
    }
  }
};

/** A harness frame with the SDK's live request id where it answers one. */
const withLiveId = (data) => {
  const id = answerId(data);
  if (id === undefined || !liveIds.has(id)) return data;
  return { ...data, response: { ...data.response, request_id: liveIds.get(id) } };
};

/** A harness frame with every recorded user-message uuid swapped for the live one. */
const withLiveUuids = (data) => {
  if (liveUuids.size === 0) return data;
  const swap = (value) => {
    if (typeof value === "string") return liveUuids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(swap);
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, swap(entry)]));
  };
  return swap(data);
};

for (const [position, frame] of frames.entries()) {
  if (frame.dir === "from-harness") {
    if (isObject(frame.data) && frame.data.type === "control_request") {
      harnessRequests.set(frame.data.request_id, frame.data.request?.subtype);
    }
    await write(frame.channel, withLiveUuids(withLiveId(frame.data)));
    continue;
  }
  const live = await takeLive(frame.data);
  const where = `invocation ${invocationIndex + 1}, frame ${position + 1}`;
  if (live === null) {
    await fail(
      `${where}: stdin closed while the recording expects\n  recorded: ${lineOf(frame.data)}`,
    );
  }
  const why = mismatch(frame.data, live);
  if (why !== null) {
    await fail(
      `${where}: the live side sent ${why}\n  recorded: ${lineOf(frame.data).trimEnd()}\n  received: ${lineOf(live).trimEnd()}`,
    );
  }
  if (frame.data.type === "control_request") {
    liveIds.set(frame.data.request_id, live.request_id);
  }
  if (frame.data.type === "user" && typeof frame.data.uuid === "string") {
    if (typeof live.uuid === "string") liveUuids.set(frame.data.uuid, live.uuid);
  }
  const id = answerId(frame.data);
  if (harnessRequests.has(id)) answered.add(id);
}

// The recording is played out: anything more the live side says is something
// the recorded run never heard, held back early or not.
const held = [...early.values(), ...earlyUsers];
if (held.length > 0) {
  await fail(
    `the recording has ended but the live side sent\n  received: ${lineOf(held[0]).trimEnd()}`,
  );
}
const extra = await nextLive();
if (extra !== null) {
  await fail(
    `the recording has ended but the live side sent\n  received: ${lineOf(extra).trimEnd()}`,
  );
}
await leave();
