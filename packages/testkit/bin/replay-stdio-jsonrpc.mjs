#!/usr/bin/env node
/**
 * Replays a recorded `stdio-jsonrpc` harness as if it were the CLI.
 *
 * This has no behaviour of its own. Everything it emits was captured from the
 * real CLI by `bin/stdio-tee.mjs` and finalised into
 * `packages/testkit/fixtures/<kind>/<scenario>/`. It chooses nothing,
 * synthesises nothing, and answers no question the recording does not already
 * answer — a test that needs a different outcome names a different recording.
 *
 * It is launched by the launcher `stdioJsonRpcReplayer(kind).config` writes:
 *
 *     node replay-stdio-jsonrpc.mjs <config.json> <the argv the connector passed>
 *
 * `config.json` names the scenario directory, the invocation counter's state
 * file and, optionally, a directory to drop a pid file into and a file to
 * append divergences to.
 *
 * Each launch takes the first unplayed invocation whose argv is of the same
 * class — `--version`, `login status`, a probe's server-mode handshake (an
 * `app-server` run whose argv holds the probe marker, `--stdio`), a session's
 * `app-server` run, or else the exact argv. A probe that asks twice — a
 * handshake included — hears the last recorded answer again, because how often
 * a server probes is its own business; a session with no recorded run left to
 * play is a divergence.
 *
 * A simple invocation prints its recorded stdout and stderr and exits with its
 * recorded code. A server-mode run walks its frames in order:
 *
 *   - a frame from the harness is written to its channel;
 *   - at a frame to the harness, the replay blocks on the next line of stdin and
 *     checks it is the same move: a request or notification with the same
 *     `method`, a request where a request was recorded; an answer to a request
 *     the harness made with the same `id`, a result or an error as recorded,
 *     the same `result.decision` for an approval and the same answer keys
 *     (`result.answers`) for a question. Answers to two open harness requests
 *     may arrive in either order, and so may a connector message and the
 *     answer to an open harness request; each is still checked in its
 *     recorded place, and nothing else may cross;
 *   - the connector's own request ids are its own, so each recorded one is
 *     mapped to the live one when the request arrives, and the recorded
 *     response to it is rewritten to carry the live id. The harness's request
 *     ids are the recording's, so the live answers carry them unchanged;
 *   - after the last frame it waits for stdin to close, then leaves the way the
 *     recorded run left, by exit code or by signal.
 *
 * Divergence is loud: anything the live side says that the recording did not,
 * or stdin closing while the recording still expects input, prints both sides
 * to stderr — and appends them to the config's `divergenceLog` when it names
 * one — and exits 97.
 *
 * `<HOME>`, `<SCRATCH>` and `<TMPDIR>` in the recording are put back from this
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
/** Spelled as `STDIO_JSONRPC_PROBE_MARKER` in `src/stdioJsonRpcRecording.ts`. */
const PROBE_MARKER = "--stdio";

const [configPath, ...argv] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(config.scenarioDir, "manifest.json"), "utf8"),
);
const label = `${manifest.kind}/${manifest.scenario}`;

const drained = (stream) => new Promise((resolve) => stream.write("", resolve));

const fail = async (message) => {
  const said = `replay-stdio-jsonrpc: ${label}: ${message}\n`;
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
  if (args.includes("--version") || args.includes("-V")) return "version";
  if (args[0] === "login" && args[1] === "status") return "login-status";
  if (args.includes("app-server")) return args.includes(PROBE_MARKER) ? "probe-server" : "server";
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
const serving = wanted === "server" || wanted === "probe-server";
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
  const pick = next ?? (wanted === "server" ? undefined : candidates.at(-1));
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
const tmpdir = os.tmpdir();
const inJson = (text) => JSON.stringify(text).slice(1, -1);
const unscrub = (line) =>
  line
    .split("<HOME>")
    .join(inJson(home))
    .split("<SCRATCH>")
    .join(inJson(scratch))
    .split("<TMPDIR>")
    .join(inJson(tmpdir));

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

if (!serving) {
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

/** Requests the harness made, by id → method. */
const harnessRequests = new Map();
const answered = new Set();
/** Answers that arrived ahead of an earlier open request's answer, or of a connector message. */
const early = new Map();
/** Connector messages that arrived while an open request's answer was awaited. */
const earlyMessages = [];
/** The connector's own request ids: recorded → live. */
const liveIds = new Map();

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasId = (data) => isObject(data) && data.id !== undefined && data.id !== null;
/** A request or a notification: anything with a method. */
const isMessage = (data) => isObject(data) && typeof data.method === "string";
/** The id a response answers; undefined for anything else. */
const answerId = (data) => (hasId(data) && !isMessage(data) ? data.id : undefined);

/** A decision as a comparable word: its name, or the key of its object form. */
const decisionOf = (decision) =>
  isObject(decision) ? Object.keys(decision).sort().join(",") : JSON.stringify(decision);
const keysOf = (value) =>
  isObject(value) ? Object.keys(value).sort().join(",") : JSON.stringify(value);

/** Why `live` is not the move `recorded` was, or null when it is. */
const mismatch = (recorded, live) => {
  if (!isObject(recorded)) return live === recorded ? null : "a different line";
  if (!isObject(live)) return "not a JSON object";
  if (isMessage(recorded)) {
    if (!isMessage(live)) return "a response where a request or notification was recorded";
    if (live.method !== recorded.method) return "a different method";
    if (hasId(live) !== hasId(recorded)) {
      return hasId(recorded)
        ? "a notification where a request was recorded"
        : "a request where a notification was recorded";
    }
    return null;
  }
  if (isMessage(live)) return "a request or notification where a response was recorded";
  if (live.id !== recorded.id) return "an answer to a different request";
  if ("error" in live !== "error" in recorded) {
    return "error" in recorded
      ? "a result where an error was recorded"
      : "an error where a result was recorded";
  }
  const said = (data) => (isObject(data.result) ? data.result : {});
  if (
    ("decision" in said(recorded) || "decision" in said(live)) &&
    decisionOf(said(live).decision) !== decisionOf(said(recorded).decision)
  ) {
    return "a different decision";
  }
  if (
    ("answers" in said(recorded) || "answers" in said(live)) &&
    keysOf(said(live).answers) !== keysOf(said(recorded).answers)
  ) {
    return "answers to different questions";
  }
  return null;
};

/** The live line that should be `recorded`, holding back what arrived early. */
const takeLive = async (recorded) => {
  const awaited = harnessRequests.has(answerId(recorded)) ? answerId(recorded) : undefined;
  if (awaited !== undefined && early.has(awaited)) {
    const live = early.get(awaited);
    early.delete(awaited);
    return live;
  }
  if (isMessage(recorded) && earlyMessages.length > 0) return earlyMessages.shift();
  for (;;) {
    const live = await nextLive();
    const id = answerId(live);
    const openAnswer = harnessRequests.has(id) && !answered.has(id) && !early.has(id);
    if (openAnswer && id !== awaited && (awaited !== undefined || isMessage(recorded))) {
      early.set(id, live);
    } else if (awaited !== undefined && isMessage(live)) {
      earlyMessages.push(live);
    } else {
      return live;
    }
  }
};

/** A harness frame with the connector's live request id where it answers one. */
const withLiveId = (data) => {
  const id = answerId(data);
  if (id === undefined || !liveIds.has(id)) return data;
  return { ...data, id: liveIds.get(id) };
};

for (const [position, frame] of frames.entries()) {
  if (frame.dir === "from-harness") {
    if (isMessage(frame.data) && hasId(frame.data)) {
      harnessRequests.set(frame.data.id, frame.data.method);
      answered.delete(frame.data.id);
    }
    await write(frame.channel, withLiveId(frame.data));
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
  if (isMessage(frame.data) && hasId(frame.data)) liveIds.set(frame.data.id, live.id);
  const id = answerId(frame.data);
  if (harnessRequests.has(id)) answered.add(id);
}

// The recording is played out: anything more the live side says is something
// the recorded run never heard, held back early or not.
const held = [...early.values(), ...earlyMessages];
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
