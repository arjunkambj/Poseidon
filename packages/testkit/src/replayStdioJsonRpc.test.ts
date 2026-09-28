/**
 * The `stdio-jsonrpc` replayer, spawned as a real process.
 *
 * The recordings it replays are made first, in a temp directory, by the real
 * tee in front of an ordinary node program (`stdioCounterpart.ts`) speaking
 * JSON-RPC — never a harness stand-in, and never under `fixtures/`. What is
 * under test is the transport mechanics: gating on stdin, id rewriting, loud
 * divergence, answers in either order, and which recorded invocation a launch
 * plays.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPLAY_DIVERGED, stdioJsonRpcReplayer } from "./replayStdioJsonRpc";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "./sdkStreamRecording";
import { converse, writeCounterpart } from "./stdioCounterpart";
import { finalizeStdioJsonRpcRecording, STDIO_JSONRPC_PROBE_MARKER } from "./stdioJsonRpcRecording";

const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stdio-jsonrpc-replay-"));
const FIXTURES = NodePath.join(ROOT, "fixtures");
const SERVER_ARGS = ["app-server"];
const PROBE_ARGS = ["app-server", STDIO_JSONRPC_PROBE_MARKER];
/** Where the recordings are made, and where they are replayed: different scratch roots. */
const REPO = NodePath.join(ROOT, "scratch", "repo");
const REPLAY_REPO = NodePath.join(ROOT, "elsewhere", "repo");

type Run = ReturnType<typeof converse>;
type Id = string | number;

interface Line {
  readonly id?: Id;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

const responseTo =
  (id: Id) =>
  (line: unknown): boolean =>
    (line as Line).id === id && (line as Line).method === undefined;
const requestOf =
  (method: string) =>
  (line: unknown): boolean =>
    (line as Line).method === method && (line as Line).id !== undefined;
const notificationOf =
  (method: string) =>
  (line: unknown): boolean =>
    (line as Line).method === method && (line as Line).id === undefined;

/** Initialize, then the notification that follows it. */
const handshake = async (run: Run, id: Id): Promise<Line> => {
  run.send({ id, method: "initialize", params: { clientInfo: { name: "test" } } });
  const initialized = (await run.awaitLine(responseTo(id))) as Line;
  run.send({ method: "initialized" });
  await run.awaitLine(notificationOf("echo"));
  return initialized;
};

/** Asks, and answers the approval the program raises with `decision`. */
const askAndAnswer = async (run: Run, id: Id, decision: string): Promise<Line> => {
  run.send({ id, method: "ask", params: { command: "ls" } });
  const asked = (await run.awaitLine(responseTo(id))) as Line;
  const approval = (await run.awaitLine(requestOf("approve"))) as { id: number };
  run.send({ id: approval.id, result: { decision } });
  await run.awaitLine(notificationOf("answered"));
  return asked;
};

/** Asks twice back to back, so both approvals are open together. */
const askTwice = async (run: Run): Promise<void> => {
  await handshake(run, 0);
  run.send({ id: 1, method: "ask", params: { command: "one" } });
  run.send({ id: 2, method: "ask", params: { command: "two" } });
  await run.awaitLine(requestOf("approve"));
  await run.awaitLine(requestOf("approve"));
};

const approvalAnswer = (id: number, decision: string): unknown => ({ id, result: { decision } });

const closeAndExit = async (run: Run): Promise<number | null> => {
  run.child.stdin.end();
  return (await run.exited).code;
};

let configs = 0;
const binaryFor = (scenario: string, extra: { pidDir?: string; divergenceLog?: string } = {}) =>
  stdioJsonRpcReplayer("sample", FIXTURES).config(scenario, {
    tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`),
    ...extra,
  }).binaryPath;

const finalize = (scenario: string, rawDir: string, prompts: ReadonlyArray<string>): void => {
  finalizeStdioJsonRpcRecording({
    kind: "sample",
    scenario,
    rawDir,
    description: "an ordinary node program, for the replayer's own test",
    cliVersion: "9.9.9",
    model: "none",
    prompts,
    fixturesRoot: FIXTURES,
  });
};

beforeAll(async () => {
  NodeFS.mkdirSync(REPO, { recursive: true });
  NodeFS.mkdirSync(REPLAY_REPO, { recursive: true });
  const counterpart = writeCounterpart(NodePath.join(ROOT, "bin"));
  const tee = (name: string): readonly [string, string] => {
    const rawDir = NodePath.join(ROOT, `raw-${name}`);
    return [makeTeeLauncher({ realBinary: counterpart, rawDir }), rawDir];
  };

  // "exchange": a version probe, a login status, a probe's handshake, then two
  // sessions, the first answered "accept" and the second "decline".
  const [exchange, exchangeRaw] = tee("exchange");
  expect((await converse(exchange, ["--version"], { cwd: REPO }).exited).code).toBe(0);
  expect((await converse(exchange, ["login", "status"], { cwd: REPO }).exited).code).toBe(0);
  const probe = converse(exchange, PROBE_ARGS, { cwd: REPO });
  await handshake(probe, 0);
  expect(await closeAndExit(probe)).toBe(0);
  for (const decision of ["accept", "decline"]) {
    const run = converse(exchange, SERVER_ARGS, { cwd: REPO });
    await handshake(run, 0);
    await askAndAnswer(run, 1, decision);
    expect(await closeAndExit(run)).toBe(0);
  }
  finalize("exchange", exchangeRaw, ["ls", "ls"]);

  // "two-open": two approvals open at once, answered in the order they were raised.
  const [twoOpen, twoOpenRaw] = tee("two-open");
  const both = converse(twoOpen, SERVER_ARGS, { cwd: REPO });
  await askTwice(both);
  both.send(approvalAnswer(0, "accept"));
  both.send(approvalAnswer(1, "decline"));
  await both.awaitLine(notificationOf("answered"));
  await both.awaitLine(notificationOf("answered"));
  expect(await closeAndExit(both)).toBe(0);
  finalize("two-open", twoOpenRaw, ["one", "two"]);

  // "one-by-one": each ask answered before the next is sent.
  const [oneByOne, oneByOneRaw] = tee("one-by-one");
  const turns = converse(oneByOne, SERVER_ARGS, { cwd: REPO });
  await handshake(turns, 0);
  await askAndAnswer(turns, 1, "accept");
  await askAndAnswer(turns, 2, "decline");
  expect(await closeAndExit(turns)).toBe(0);
  finalize("one-by-one", oneByOneRaw, ["one", "two"]);

  // "question": a question answered, then the program told to exit 3.
  const [question, questionRaw] = tee("question");
  const asking = converse(question, SERVER_ARGS, { cwd: REPO });
  await handshake(asking, 0);
  asking.send({ id: 1, method: "question", params: { questions: [{ id: "q1" }] } });
  const raised = (await asking.awaitLine(requestOf("question"))) as { id: number };
  asking.send({ id: raised.id, result: { answers: { q1: { answers: ["yes"] } } } });
  await asking.awaitLine(notificationOf("answered"));
  asking.send({ method: "exit", params: { code: 3 } });
  asking.child.stdin.end();
  expect((await asking.exited).code).toBe(3);
  finalize("question", questionRaw, ["q1"]);

  // An sdk-stream recording, which this replayer refuses.
  const [, streamRaw] = tee("stream");
  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "stream",
    rawDir: streamRaw,
    description: "an empty capture under another transport",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: [],
    fixturesRoot: FIXTURES,
  });
});

afterAll(() => {
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
});

describe("stdioJsonRpcReplayer", () => {
  it("is the stdio-jsonrpc replayer for the kind it is given", () => {
    const replayer = stdioJsonRpcReplayer("sample", FIXTURES);
    expect(replayer.kind).toBe("sample");
    expect(replayer.transport).toBe("stdio-jsonrpc");
    expect(REPLAY_DIVERGED).toBe(97);
  });

  it("refuses a scenario recorded over another transport, or not recorded", () => {
    expect(() => binaryFor("stream")).toThrow(/recorded over sdk-stream, not stdio-jsonrpc/);
    expect(() => binaryFor("missing")).toThrow();
  });

  it("plays a matched session out, with the live request ids and this machine's directories", async () => {
    const run = converse(binaryFor("exchange"), SERVER_ARGS, { cwd: REPLAY_REPO });
    const initialized = await handshake(run, "live-init");
    // The recorded answer to request 0 carries the live id, and `<SCRATCH>`
    // and `<TMPDIR>` are put back from this run's own directories.
    expect(initialized).toMatchObject({
      id: "live-init",
      result: { cwd: NodeFS.realpathSync(REPLAY_REPO), tmp: NodeOS.tmpdir() },
    });
    // The harness's own request 0 is not the connector's request 0.
    expect(await askAndAnswer(run, 42, "accept")).toMatchObject({ id: 42 });
    expect(run.seen()).toContainEqual(
      expect.objectContaining({ method: "approve", id: 0 }) as unknown,
    );
    expect(await closeAndExit(run)).toBe(0);
  });

  it("writes nothing past a frame the live side has not sent yet", async () => {
    const run = converse(binaryFor("exchange"), SERVER_ARGS, { cwd: REPLAY_REPO });
    run.child.stdin.end();
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("stdin closed while the recording expects");
    expect(run.seen()).toEqual([]);
  });

  it("exits 97 on a different method, and appends it to the divergence log", async () => {
    const divergenceLog = NodePath.join(ROOT, "diverged-method.log");
    const run = converse(binaryFor("exchange", { divergenceLog }), SERVER_ARGS, {
      cwd: REPLAY_REPO,
    });
    run.send({ id: 0, method: "thread/start", params: {} });
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different method");
    expect(exit.stderr).toContain('"method":"initialize"');
    expect(exit.stderr).toContain('"method":"thread/start"');
    expect(NodeFS.readFileSync(divergenceLog, "utf8")).toContain("a different method");
  });

  it("exits 97 on a notification where a request was recorded", async () => {
    const run = converse(binaryFor("exchange"), SERVER_ARGS, { cwd: REPLAY_REPO });
    run.send({ method: "initialize", params: {} });
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a notification where a request was recorded");
  });

  it("exits 97 when the live decision differs from the recorded one", async () => {
    const run = converse(binaryFor("exchange"), SERVER_ARGS, { cwd: REPLAY_REPO });
    await handshake(run, 0);
    run.send({ id: 1, method: "ask", params: { command: "ls" } });
    const approval = (await run.awaitLine(requestOf("approve"))) as { id: number };
    run.send(approvalAnswer(approval.id, "decline"));
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different decision");
    expect(exit.stderr).toContain('"decision":"accept"');
    expect(exit.stderr).toContain('"decision":"decline"');
  });

  it("takes answers to two open requests in either order, and still checks each", async () => {
    const run = converse(binaryFor("two-open"), SERVER_ARGS, { cwd: REPLAY_REPO });
    await askTwice(run);
    run.send(approvalAnswer(1, "decline"));
    run.send(approvalAnswer(0, "accept"));
    await run.awaitLine(notificationOf("answered"));
    await run.awaitLine(notificationOf("answered"));
    expect(await closeAndExit(run)).toBe(0);

    const swapped = converse(binaryFor("two-open"), SERVER_ARGS, { cwd: REPLAY_REPO });
    await askTwice(swapped);
    swapped.send(approvalAnswer(1, "accept"));
    swapped.send(approvalAnswer(0, "accept"));
    const exit = await swapped.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different decision");
  });

  it("takes a request that crossed an open approval's answer, in its recorded place", async () => {
    const run = converse(binaryFor("one-by-one"), SERVER_ARGS, { cwd: REPLAY_REPO });
    await handshake(run, 0);
    run.send({ id: 1, method: "ask", params: { command: "ls" } });
    const first = (await run.awaitLine(requestOf("approve"))) as { id: number };
    // The second ask goes out before the first approval's answer.
    run.send({ id: 2, method: "ask", params: { command: "ls" } });
    run.send(approvalAnswer(first.id, "accept"));
    const second = (await run.awaitLine(requestOf("approve"))) as { id: number };
    run.send(approvalAnswer(second.id, "decline"));
    await run.awaitLine(
      (line) =>
        notificationOf("answered")(line) &&
        (line as { params: { id: number } }).params.id === second.id,
    );
    expect(await closeAndExit(run)).toBe(0);
  });

  it("checks a question's answer keys, and exits as the recorded run did", async () => {
    const answer = async (keys: Record<string, unknown>) => {
      const run = converse(binaryFor("question"), SERVER_ARGS, { cwd: REPLAY_REPO });
      await handshake(run, 0);
      run.send({ id: 1, method: "question", params: { questions: [{ id: "q1" }] } });
      const raised = (await run.awaitLine(requestOf("question"))) as { id: number };
      run.send({ id: raised.id, result: { answers: keys } });
      return run;
    };

    const matched = await answer({ q1: { answers: ["no"] } });
    await matched.awaitLine(notificationOf("answered"));
    matched.send({ method: "exit", params: { code: 3 } });
    expect(await closeAndExit(matched)).toBe(3);

    const other = await answer({ q2: { answers: ["yes"] } });
    const exit = await other.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("answers to different questions");
  });

  it("plays the next recorded invocation of each argv class, counted across launches", async () => {
    const pidDir = NodePath.join(ROOT, "pids");
    const binary = binaryFor("exchange", { pidDir });

    const version = converse(binary, ["--version"], { cwd: REPLAY_REPO });
    expect(await version.awaitLine()).toBe("9.9.9 (counterpart)");
    expect((await version.exited).code).toBe(0);

    const first = converse(binary, SERVER_ARGS, { cwd: REPLAY_REPO });
    await handshake(first, "a-0");
    await askAndAnswer(first, "a-1", "accept");
    expect(await closeAndExit(first)).toBe(0);

    // A probe asked again hears the last recorded answer again.
    const status = converse(binary, ["login", "status"], { cwd: REPLAY_REPO });
    expect(await status.awaitLine()).toBe("Logged in as user@example.com");
    expect((await status.exited).code).toBe(0);
    for (const id of ["probe-1", "probe-2"]) {
      const probe = converse(binary, PROBE_ARGS, { cwd: REPLAY_REPO });
      expect(await handshake(probe, id)).toMatchObject({ id });
      expect(await closeAndExit(probe)).toBe(0);
    }

    // The second session launch is the second recorded run, answered "decline".
    const second = converse(binary, SERVER_ARGS, { cwd: REPLAY_REPO });
    await handshake(second, "b-0");
    await askAndAnswer(second, "b-1", "decline");
    expect(await closeAndExit(second)).toBe(0);

    const third = converse(binary, SERVER_ARGS, { cwd: REPLAY_REPO });
    const exit = await third.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("no recorded invocation left");

    expect(NodeFS.readdirSync(pidDir)).toHaveLength(7);
  });
});
