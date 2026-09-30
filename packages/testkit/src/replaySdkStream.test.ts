/**
 * The `sdk-stream` replayer, spawned as a real process.
 *
 * The recording it replays is made first, in a temp directory, by the real tee
 * in front of an ordinary node program (`stdioCounterpart.ts`) — never a
 * harness stand-in, and never under `fixtures/`. What is under test is the
 * transport mechanics: gating on stdin, request-id rewriting, loud divergence,
 * and which recorded invocation a launch plays.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPLAY_DIVERGED, sdkStreamReplayer } from "./replaySdkStream";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "./sdkStreamRecording";
import { converse, writeCounterpart } from "./stdioCounterpart";

const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sdk-stream-replay-"));
const FIXTURES = NodePath.join(ROOT, "fixtures");
const STREAM_ARGS = ["--output-format", "stream-json", "--input-format", "stream-json"];
/** A handshake that keeps no session, the way a probe runs. */
const PROBE_ARGS = [...STREAM_ARGS, "--no-session-persistence"];
/** Where the replays run: a different scratch root from the recording's. */
const REPLAY_REPO = NodePath.join(ROOT, "elsewhere", "repo");

const typed =
  (type: string) =>
  (line: unknown): boolean =>
    (line as { type?: string }).type === type;

type Run = ReturnType<typeof converse>;

/** The session id the recording of `named` was handed. */
const RECORDED_SESSION = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

const initialize = (requestId: string): unknown => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "initialize" },
});

/** One full exchange: initialize, a user message, and an answer to the question it raises. */
const exchange = async (run: Run, requestId: string, behavior: string): Promise<unknown> => {
  await run.awaitLine(typed("ready"));
  run.send(initialize(requestId));
  const initialized = await run.awaitLine(typed("control_response"));
  run.send({ type: "user", message: { role: "user", content: "hello" } });
  const asked = (await run.awaitLine(typed("control_request"))) as { request_id: string };
  run.send({
    type: "control_response",
    response: { subtype: "success", request_id: asked.request_id, response: { behavior } },
  });
  return initialized;
};

const answer = (requestId: string, behavior: string): unknown => ({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response: { behavior } },
});

/** Two user messages sent back to back, so both questions they raise are open together. */
const askTwice = async (run: Run): Promise<void> => {
  await run.awaitLine(typed("ready"));
  run.send({ type: "user", message: { role: "user", content: "one" } });
  run.send({ type: "user", message: { role: "user", content: "two" } });
  await run.awaitLine(typed("control_request"));
  await run.awaitLine(typed("control_request"));
};

/** A user message stamped with `uuid`, its receipt, and its question answered. */
const sendStamped = async (run: Run, uuid: string): Promise<unknown> => {
  await run.awaitLine(typed("ready"));
  run.send({ type: "user", message: { role: "user", content: "hello" }, uuid });
  const receipt = await run.awaitLine(typed("receipt"));
  const asked = (await run.awaitLine(typed("control_request"))) as { request_id: string };
  run.send(answer(asked.request_id, "allow"));
  await run.awaitLine(typed("result"));
  return receipt;
};

beforeAll(async () => {
  const repo = NodePath.join(ROOT, "scratch", "repo");
  NodeFS.mkdirSync(repo, { recursive: true });
  NodeFS.mkdirSync(REPLAY_REPO, { recursive: true });
  const rawDir = NodePath.join(ROOT, "raw");
  const launcher = makeTeeLauncher({
    realBinary: writeCounterpart(NodePath.join(ROOT, "bin")),
    rawDir,
  });

  // Invocation 1: a version probe. 2: a run answered "allow". 3: one answered "deny".
  expect((await converse(launcher, ["--version"], { cwd: repo }).exited).code).toBe(0);
  for (const [id, behavior] of [
    ["recorded-1", "allow"],
    ["recorded-2", "deny"],
  ] as const) {
    const run = converse(launcher, STREAM_ARGS, { cwd: repo });
    await exchange(run, id, behavior);
    await run.awaitLine(typed("result"));
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);
  }

  // A run with two questions open at once, answered in the order they were asked.
  const twoOpenRaw = NodePath.join(ROOT, "raw-two-open");
  const twoOpen = converse(
    makeTeeLauncher({
      realBinary: NodePath.join(ROOT, "bin", "counterpart.mjs"),
      rawDir: twoOpenRaw,
    }),
    STREAM_ARGS,
    { cwd: repo },
  );
  await askTwice(twoOpen);
  for (const [id, behavior] of [
    ["asked-1", "allow"],
    ["asked-2", "deny"],
  ]) {
    twoOpen.send(answer(id!, behavior!));
  }
  await twoOpen.awaitLine(
    (line) => typed("result")(line) && (line as { request_id?: string }).request_id === "asked-2",
  );
  twoOpen.child.stdin.end();
  expect((await twoOpen.exited).code).toBe(0);
  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "two-open",
    rawDir: twoOpenRaw,
    description: "an ordinary node program with two requests open at once",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: ["one", "two"],
    fixturesRoot: FIXTURES,
  });

  // A probe's handshake — a run that keeps no session — then a session.
  const probedRaw = NodePath.join(ROOT, "raw-probed");
  const probedLauncher = makeTeeLauncher({
    realBinary: NodePath.join(ROOT, "bin", "counterpart.mjs"),
    rawDir: probedRaw,
  });
  const handshake = converse(probedLauncher, PROBE_ARGS, { cwd: repo });
  await handshake.awaitLine(typed("ready"));
  handshake.send(initialize("probe-1"));
  await handshake.awaitLine(typed("control_response"));
  handshake.child.stdin.end();
  expect((await handshake.exited).code).toBe(0);
  const session = converse(probedLauncher, STREAM_ARGS, { cwd: repo });
  await exchange(session, "session-1", "allow");
  await session.awaitLine(typed("result"));
  session.child.stdin.end();
  expect((await session.exited).code).toBe(0);
  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "probed",
    rawDir: probedRaw,
    description: "an ordinary node program, probed once and then run as a session",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: ["hello"],
    fixturesRoot: FIXTURES,
  });

  // A user message stamped with a uuid, which the program's receipt names.
  const stampedRaw = NodePath.join(ROOT, "raw-stamped");
  const stamped = converse(
    makeTeeLauncher({
      realBinary: NodePath.join(ROOT, "bin", "counterpart.mjs"),
      rawDir: stampedRaw,
    }),
    STREAM_ARGS,
    { cwd: repo },
  );
  await sendStamped(stamped, "recorded-uuid");
  stamped.child.stdin.end();
  expect((await stamped.exited).code).toBe(0);
  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "stamped",
    rawDir: stampedRaw,
    description: "an ordinary node program answering a uuid-stamped user message",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: ["hello"],
    fixturesRoot: FIXTURES,
  });

  // A session run handed its id, which a note names back.
  const namedRaw = NodePath.join(ROOT, "raw-named");
  const named = converse(
    makeTeeLauncher({
      realBinary: NodePath.join(ROOT, "bin", "counterpart.mjs"),
      rawDir: namedRaw,
    }),
    [...STREAM_ARGS, `--session-id=${RECORDED_SESSION}`],
    { cwd: repo },
  );
  await named.awaitLine(typed("ready"));
  named.send({ type: "note", session_id: RECORDED_SESSION });
  await named.awaitLine(typed("echo"));
  named.child.stdin.end();
  expect((await named.exited).code).toBe(0);
  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "named",
    rawDir: namedRaw,
    description: "an ordinary node program handed a session id",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: [],
    fixturesRoot: FIXTURES,
  });

  // Two user messages, each asked about and answered before the next is sent.
  const oneByOneRaw = NodePath.join(ROOT, "raw-one-by-one");
  const oneByOne = converse(
    makeTeeLauncher({
      realBinary: NodePath.join(ROOT, "bin", "counterpart.mjs"),
      rawDir: oneByOneRaw,
    }),
    STREAM_ARGS,
    { cwd: repo },
  );
  await oneByOne.awaitLine(typed("ready"));
  for (const [content, behavior] of [
    ["one", "allow"],
    ["two", "deny"],
  ] as const) {
    oneByOne.send({ type: "user", message: { role: "user", content } });
    const asked = (await oneByOne.awaitLine(typed("control_request"))) as { request_id: string };
    oneByOne.send(answer(asked.request_id, behavior));
    await oneByOne.awaitLine(typed("result"));
  }
  oneByOne.child.stdin.end();
  expect((await oneByOne.exited).code).toBe(0);
  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "one-by-one",
    rawDir: oneByOneRaw,
    description: "an ordinary node program asked about two user messages in turn",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: ["one", "two"],
    fixturesRoot: FIXTURES,
  });

  finalizeSdkStreamRecording({
    kind: "sample",
    scenario: "exchange",
    rawDir,
    description: "an ordinary node program, for the replayer's own test",
    cliVersion: "9.9.9",
    sdkVersion: "0.0.0",
    model: "none",
    prompts: ["hello", "hello"],
    fixturesRoot: FIXTURES,
  });
});

afterAll(() => {
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
});

const replayer = sdkStreamReplayer("sample", FIXTURES);
let configs = 0;
/** A fresh launcher with a fresh invocation counter. */
const freshBinary = (pidDir?: string): string =>
  replayer.config("exchange", {
    tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`),
    ...(pidDir === undefined ? {} : { pidDir }),
  }).binaryPath;

describe("sdkStreamReplayer", () => {
  it("is the sdk-stream replayer for the kind it is given", () => {
    expect(replayer.kind).toBe("sample");
    expect(replayer.transport).toBe("sdk-stream");
  });

  it("writes nothing past a frame the live side has not sent yet", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    const ready = (await run.awaitLine(typed("ready"))) as { cwd: string };
    // `<SCRATCH>` is put back from this run's own directories.
    expect(ready.cwd).toBe(NodeFS.realpathSync(REPLAY_REPO));
    run.child.stdin.end();

    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("stdin closed while the recording expects");
    // The recorded initialize answer was never written: the replay was
    // blocked on the request it answers.
    expect(run.seen()).toEqual([ready]);
  });

  it("rewrites the SDK's own request ids to the live ones", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    const initialized = await exchange(run, "live-42", "allow");
    expect(initialized).toMatchObject({ response: { request_id: "live-42" } });
    expect(await run.awaitLine(typed("result"))).toMatchObject({ behavior: "allow" });
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);
  });

  it("rewrites a user message's recorded uuid to the live one in what follows", async () => {
    const binaryPath = replayer.config("stamped", {
      tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`),
    }).binaryPath;
    const run = converse(binaryPath, STREAM_ARGS, { cwd: REPLAY_REPO });
    expect(await sendStamped(run, "live-uuid")).toEqual({
      type: "receipt",
      command_uuid: "live-uuid",
    });
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);
  });

  it("rewrites the recorded session id to the one the live argv hands it", async () => {
    const live = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    for (const flag of [[`--session-id=${live}`], ["--resume", live]]) {
      const binaryPath = replayer.config("named", {
        tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`),
      }).binaryPath;
      const run = converse(binaryPath, [...STREAM_ARGS, ...flag], { cwd: REPLAY_REPO });
      await run.awaitLine(typed("ready"));
      run.send({ type: "note", session_id: live });
      expect(await run.awaitLine(typed("echo"))).toMatchObject({
        message: { session_id: live },
      });
      run.child.stdin.end();
      expect((await run.exited).code).toBe(0);
    }
  });

  it("takes a user message that crossed an open request's answer, in its recorded place", async () => {
    const binaryPath = replayer.config("one-by-one", {
      tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`),
    }).binaryPath;
    const run = converse(binaryPath, STREAM_ARGS, { cwd: REPLAY_REPO });
    await run.awaitLine(typed("ready"));
    run.send({ type: "user", message: { role: "user", content: "one" } });
    const first = (await run.awaitLine(typed("control_request"))) as { request_id: string };
    // The second message goes out before the first question's answer.
    run.send({ type: "user", message: { role: "user", content: "two" } });
    run.send(answer(first.request_id, "allow"));
    expect(await run.awaitLine(typed("result"))).toMatchObject({ behavior: "allow" });
    const second = (await run.awaitLine(typed("control_request"))) as { request_id: string };
    run.send(answer(second.request_id, "deny"));
    expect(await run.awaitLine(typed("result"))).toMatchObject({ behavior: "deny" });
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);
  });

  it("exits 97 when a held-back message is never asked for", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await run.awaitLine(typed("ready"));
    run.send(initialize("live-1"));
    await run.awaitLine(typed("control_response"));
    run.send({ type: "user", message: { role: "user", content: "hello" } });
    const asked = (await run.awaitLine(typed("control_request"))) as { request_id: string };
    // A message the recording never has, sent while the question is open.
    run.send({ type: "user", message: { role: "user", content: "extra" } });
    run.send(answer(asked.request_id, "allow"));
    run.child.stdin.end();
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("the recording has ended but the live side sent");
  });

  it("exits 97 when the live answer differs from the recorded one", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await exchange(run, "live-1", "deny");
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different behavior");
    expect(exit.stderr).toContain('"behavior":"allow"');
    expect(exit.stderr).toContain('"behavior":"deny"');
  });

  it("appends each divergence to the divergence log when it is given one", async () => {
    const tmpDir = NodePath.join(ROOT, `replay-${(configs += 1)}`);
    const divergenceLog = NodePath.join(tmpDir, "diverged.log");
    const binary = replayer.config("exchange", { tmpDir, divergenceLog }).binaryPath;
    const run = converse(binary, STREAM_ARGS, { cwd: REPLAY_REPO });
    await exchange(run, "live-1", "deny");
    expect((await run.exited).code).toBe(REPLAY_DIVERGED);
    expect(NodeFS.readFileSync(divergenceLog, "utf8")).toContain("a different behavior");
  });

  it("exits 97 when the live side sends a different kind of line", async () => {
    const run = converse(freshBinary(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await run.awaitLine(typed("ready"));
    run.send({ type: "user", message: { role: "user", content: "too early" } });
    const exit = await run.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different type");
  });

  it("plays the next recorded invocation of each argv class, counted across launches", async () => {
    const pidDir = NodePath.join(ROOT, "pids");
    const binary = freshBinary(pidDir);

    const version = converse(binary, ["--version"], { cwd: REPLAY_REPO });
    expect(await version.awaitLine()).toBe("9.9.9 (counterpart)");
    expect((await version.exited).code).toBe(0);

    const first = converse(binary, STREAM_ARGS, { cwd: REPLAY_REPO });
    await exchange(first, "live-a", "allow");
    expect(await first.awaitLine(typed("result"))).toMatchObject({ behavior: "allow" });
    first.child.stdin.end();
    expect((await first.exited).code).toBe(0);

    // A probe asked again hears the last recorded answer again.
    const again = converse(binary, ["--version"], { cwd: REPLAY_REPO });
    expect(await again.awaitLine()).toBe("9.9.9 (counterpart)");
    expect((await again.exited).code).toBe(0);

    // The second stream launch is the second recorded run, answered "deny".
    const second = converse(binary, STREAM_ARGS, { cwd: REPLAY_REPO });
    await exchange(second, "live-b", "deny");
    expect(await second.awaitLine(typed("result"))).toMatchObject({ behavior: "deny" });
    second.child.stdin.end();
    expect((await second.exited).code).toBe(0);

    const third = converse(binary, STREAM_ARGS, { cwd: REPLAY_REPO });
    const exit = await third.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("no recorded invocation left");

    expect(NodeFS.readdirSync(pidDir)).toHaveLength(5);
  });

  it("takes answers to two open requests in either order, and still checks each", async () => {
    const twoOpen = (): string =>
      replayer.config("two-open", { tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`) })
        .binaryPath;
    const run = converse(twoOpen(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await askTwice(run);
    run.send(answer("asked-2", "deny"));
    run.send(answer("asked-1", "allow"));
    await run.awaitLine(
      (line) => typed("result")(line) && (line as { request_id?: string }).request_id === "asked-2",
    );
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);

    const swapped = converse(twoOpen(), STREAM_ARGS, { cwd: REPLAY_REPO });
    await askTwice(swapped);
    swapped.send(answer("asked-2", "allow"));
    swapped.send(answer("asked-1", "allow"));
    const exit = await swapped.exited;
    expect(exit.code).toBe(REPLAY_DIVERGED);
    expect(exit.stderr).toContain("a different behavior");
  });

  it("keeps a probe's handshakes apart from sessions, and replays the last one again", async () => {
    const binary = replayer.config("probed", {
      tmpDir: NodePath.join(ROOT, `replay-${(configs += 1)}`),
    }).binaryPath;

    // The session launched first still gets the session run, not the handshake.
    const session = converse(binary, STREAM_ARGS, { cwd: REPLAY_REPO });
    await exchange(session, "live-session", "allow");
    expect(await session.awaitLine(typed("result"))).toMatchObject({ behavior: "allow" });
    session.child.stdin.end();
    expect((await session.exited).code).toBe(0);

    // However often the server probes, each handshake hears the recorded one.
    for (const id of ["live-probe-1", "live-probe-2"]) {
      const probe = converse(binary, PROBE_ARGS, { cwd: REPLAY_REPO });
      await probe.awaitLine(typed("ready"));
      probe.send(initialize(id));
      expect(await probe.awaitLine(typed("control_response"))).toMatchObject({
        response: { request_id: id },
      });
      probe.child.stdin.end();
      expect((await probe.exited).code).toBe(0);
    }
  });

  it("refuses a scenario that is not recorded", () => {
    expect(() => replayer.config("missing", { tmpDir: NodePath.join(ROOT, "nowhere") })).toThrow();
  });
});
