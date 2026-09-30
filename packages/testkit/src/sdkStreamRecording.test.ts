/**
 * The `sdk-stream` tee and finaliser, run as real processes.
 *
 * The far end of the pipes is an ordinary node program written into a temp
 * directory (`stdioCounterpart.ts`), not a harness and not a stand-in for one:
 * these tests are about lines, directions, process groups and scrubbing. The
 * recordings they make live and die in that temp directory.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readManifest, type RecordedFrame } from "./recording";
import {
  finalizeSdkStreamRecording,
  SCRUBBED_ENTRY,
  loadSdkStreamRecording,
  makeTeeLauncher,
} from "./sdkStreamRecording";
import { converse, pidGoneWithin, writeCounterpart } from "./stdioCounterpart";

const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sdk-stream-tee-"));
const REPO = NodePath.join(ROOT, "scratch", "repo");
NodeFS.mkdirSync(REPO, { recursive: true });
const COUNTERPART = writeCounterpart(NodePath.join(ROOT, "bin"));
const STREAM_ARGS = ["--output-format", "stream-json", "--input-format", "stream-json"];

afterAll(() => {
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
});

const rawFrames = (rawDir: string, n: number): ReadonlyArray<RecordedFrame> =>
  NodeFS.readFileSync(NodePath.join(rawDir, `invocation-${n}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedFrame);

const shape = (frame: RecordedFrame): string =>
  `${frame.dir} ${frame.channel} ${(frame.data as { type?: string }).type ?? String(frame.data)}`;

const typed =
  (type: string) =>
  (line: unknown): boolean =>
    (line as { type?: string }).type === type;

describe("the stdio tee", () => {
  it("captures both directions in the order they crossed, and no environment", async () => {
    const rawDir = NodePath.join(ROOT, "raw-order");
    const launcher = makeTeeLauncher({ realBinary: COUNTERPART, rawDir });
    const secret = "a-value-the-tee-must-never-write";
    const run = converse(launcher, STREAM_ARGS, {
      cwd: REPO,
      env: { ...process.env, POSEIDON_TEE_TEST_SECRET: secret },
    });

    await run.awaitLine(typed("ready"));
    run.send({ type: "control_request", request_id: "sdk-1", request: { subtype: "initialize" } });
    await run.awaitLine(typed("control_response"));
    run.send({ type: "user", message: { role: "user", content: "hello" } });
    const asked = (await run.awaitLine(typed("control_request"))) as { request_id: string };
    run.send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: asked.request_id,
        response: { behavior: "allow" },
      },
    });
    await run.awaitLine(typed("result"));
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);

    const frames = rawFrames(rawDir, 1);
    expect(frames.map(shape)).toEqual([
      "from-harness stdout ready",
      "to-harness stdin control_request",
      "from-harness stdout control_response",
      "to-harness stdin user",
      "from-harness stdout control_request",
      "to-harness stdin control_response",
      "from-harness stdout result",
    ]);
    const times = frames.map((frame) => frame.at ?? -1);
    expect(times.every((at, index) => at >= 0 && (index === 0 || at >= times[index - 1]!))).toBe(
      true,
    );

    const meta = JSON.parse(
      NodeFS.readFileSync(NodePath.join(rawDir, "invocation-1.json"), "utf8"),
    ) as { argv: ReadonlyArray<string>; exitCode: number | null; signal: string | null };
    expect(meta.argv).toEqual(STREAM_ARGS);
    expect(meta.exitCode).toBe(0);
    expect(meta.signal).toBeNull();

    for (const name of NodeFS.readdirSync(rawDir)) {
      expect(NodeFS.readFileSync(NodePath.join(rawDir, name), "utf8")).not.toContain(secret);
    }
  });

  it("keeps every frame it saw when the process group is killed", async () => {
    const rawDir = NodePath.join(ROOT, "raw-kill");
    const launcher = makeTeeLauncher({ realBinary: COUNTERPART, rawDir });
    // Detached, so the tee leads a process group of its own, the way a
    // connector spawns a harness it later kills by group.
    const run = converse(launcher, STREAM_ARGS, { cwd: REPO, detached: true });

    const ready = (await run.awaitLine(typed("ready"))) as { pid: number };
    run.send({ type: "note", text: "before the kill" });
    await run.awaitLine(typed("echo"));
    process.kill(-run.child.pid!, "SIGKILL");
    expect((await run.exited).signal).toBe("SIGKILL");

    expect(await pidGoneWithin(ready.pid, 2_000)).toBe(true);
    expect(rawFrames(rawDir, 1).map(shape)).toEqual([
      "from-harness stdout ready",
      "to-harness stdin note",
      "from-harness stdout echo",
    ]);
    const meta = JSON.parse(
      NodeFS.readFileSync(NodePath.join(rawDir, "invocation-1.json"), "utf8"),
    ) as { exitCode: number | null };
    expect(meta.exitCode).toBeNull();
  });
});

describe("finalizeSdkStreamRecording", () => {
  it("scrubs the bearer, the account and the home directory, and keeps session ids", async () => {
    const rawDir = NodePath.join(ROOT, "raw-scrub");
    const launcher = makeTeeLauncher({ realBinary: COUNTERPART, rawDir });
    const bearer = "0123456789abcdef".repeat(3);
    const home = NodeOS.homedir();
    const sessionId = "4a1f2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

    const status = converse(launcher, ["auth", "status", "--json"], { cwd: REPO });
    expect((await status.exited).code).toBe(0);

    const mcpConfig = JSON.stringify({
      mcpServers: {
        poseidon: {
          type: "http",
          url: "http://127.0.0.1:4321/mcp",
          headers: { Authorization: `Bearer ${bearer}` },
        },
      },
    });
    const run = converse(launcher, [...STREAM_ARGS, "--mcp-config", mcpConfig], { cwd: REPO });
    await run.awaitLine(typed("ready"));
    run.send({
      type: "note",
      session_id: sessionId,
      text: `someone@example.org of Example Org reads ${home}/.config/settings.json`,
      headers: { authorization: "short" },
    });
    await run.awaitLine(typed("echo"));
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);

    const fixtures = NodePath.join(ROOT, "fixtures");
    const dir = finalizeSdkStreamRecording({
      kind: "sample",
      scenario: "scrubbed",
      rawDir,
      description: "an ordinary node program, for the finaliser's own test",
      cliVersion: "9.9.9",
      sdkVersion: "0.0.0",
      model: "none",
      prompts: [`look in ${home}`],
      fixturesRoot: fixtures,
    });

    const written = NodeFS.readdirSync(dir)
      .map((name) => NodeFS.readFileSync(NodePath.join(dir, name), "utf8"))
      .join("\n");
    expect(written).not.toContain(bearer);
    expect(written).not.toContain("someone@example.org");
    expect(written).not.toContain("Example Org");
    expect(written).not.toContain(`${home}/`);
    expect(written).toContain(sessionId);

    const recording = loadSdkStreamRecording("sample", "scrubbed", fixtures);
    expect(recording.manifest).toMatchObject({
      formatVersion: 1,
      kind: "sample",
      transport: "sdk-stream",
      scenario: "scrubbed",
      cliVersion: "9.9.9",
      sdkVersion: "0.0.0",
      real: true,
      prompts: ["look in <HOME>"],
    });
    expect(recording.manifest.recordedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(recording.invocations.map((invocation) => invocation.file)).toEqual([
      "invocation-1.ndjson",
      "invocation-2.ndjson",
    ]);

    const [probe, stream] = recording.invocations;
    expect(probe!.frames[0]!.data).toMatchObject({
      email: "user@example.com",
      orgName: "<ACCOUNT>",
    });
    expect(stream!.argv.at(-1)).toContain('"Authorization":"<REDACTED>"');
    expect(stream!.cwd).toBe("<SCRATCH>/repo");
    expect(stream!.frames[0]!.data).toMatchObject({ type: "ready", cwd: "<SCRATCH>/repo" });
    expect(stream!.frames[2]!.data).toMatchObject({
      type: "echo",
      message: {
        session_id: sessionId,
        text: "user@example.com of <ACCOUNT> reads <HOME>/.config/settings.json",
        headers: { authorization: "<REDACTED>" },
      },
    });
    expect(readManifest("sample", "scrubbed", fixtures).transport).toBe("sdk-stream");
  });

  it("replaces the handshake's skill and command lists whole, and the operator's own agents by name", async () => {
    const rawDir = NodePath.join(ROOT, "raw-entries");
    const launcher = makeTeeLauncher({ realBinary: COUNTERPART, rawDir });
    const configDir = NodePath.join(ROOT, "config-dir");
    NodeFS.mkdirSync(NodePath.join(configDir, "skills", "private-notes"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(configDir, "agents"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(configDir, "agents", "reviewer.md"), "x\n");

    const run = converse(launcher, STREAM_ARGS, { cwd: REPO });
    await run.awaitLine(typed("ready"));
    run.send({
      type: "note",
      commands: [
        { name: "private-notes", description: "Notes about a private project (user)" },
        { name: "compact", description: "Compact the conversation" },
      ],
      skills: ["private-notes", "compact"],
      slash_commands: ["private-notes", "plugin-named-by-its-author", "compact"],
      agents: ["reviewer", "Explore"],
    });
    await run.awaitLine(typed("echo"));
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);

    const fixtures = NodePath.join(ROOT, "fixtures-entries");
    finalizeSdkStreamRecording({
      kind: "sample",
      scenario: "entries",
      rawDir,
      description: "an ordinary node program, for the finaliser's own test",
      cliVersion: "9.9.9",
      sdkVersion: "0.0.0",
      model: "none",
      prompts: [],
      fixturesRoot: fixtures,
      configDir,
    });

    const [stream] = loadSdkStreamRecording("sample", "entries", fixtures).invocations;
    const echoed = stream!.frames.find((frame) => typed("echo")(frame.data))!.data;
    expect(JSON.stringify(echoed)).not.toContain("private");
    expect(JSON.stringify(echoed)).not.toContain("reviewer");
    expect(JSON.stringify(echoed)).not.toContain("plugin-named-by-its-author");
    expect(echoed).toMatchObject({
      message: {
        commands: [{ name: SCRUBBED_ENTRY, description: `${SCRUBBED_ENTRY} (recording)` }],
        skills: [SCRUBBED_ENTRY],
        slash_commands: [SCRUBBED_ENTRY],
        agents: ["user-skill-2", "Explore"],
      },
    });
  });

  it("keeps a listed skill the scenario wrote under its scratch root, and the list's shape", async () => {
    const rawDir = NodePath.join(ROOT, "raw-listed");
    const launcher = makeTeeLauncher({ realBinary: COUNTERPART, rawDir });
    const scenarioSkill = NodePath.join(ROOT, "scratch", "plugin", "skills", "word", "SKILL.md");
    const run = converse(launcher, STREAM_ARGS, { cwd: REPO });
    await run.awaitLine(typed("ready"));
    run.send({
      type: "note",
      skills: [
        { name: "private-notes", path: "/elsewhere/private-notes/SKILL.md", enabled: true },
        { name: "word", path: scenarioSkill, enabled: true, interface: { icon: "x" } },
      ],
    });
    await run.awaitLine(typed("echo"));
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);

    const fixtures = NodePath.join(ROOT, "fixtures-listed");
    finalizeSdkStreamRecording({
      kind: "sample",
      scenario: "listed",
      rawDir,
      description: "an ordinary node program, for the finaliser's own test",
      cliVersion: "9.9.9",
      sdkVersion: "0.0.0",
      model: "none",
      prompts: [],
      fixturesRoot: fixtures,
    });

    const [stream] = loadSdkStreamRecording("sample", "listed", fixtures).invocations;
    const echoed = stream!.frames.find((frame) => typed("echo")(frame.data))!.data;
    expect(JSON.stringify(echoed)).not.toContain("private");
    expect(echoed).toMatchObject({
      message: {
        skills: [
          {
            name: "word",
            path: "<SCRATCH>/plugin/skills/word/SKILL.md",
            enabled: true,
            interface: { icon: "x" },
          },
          {
            name: SCRUBBED_ENTRY,
            description: `${SCRUBBED_ENTRY} (recording)`,
            path: SCRUBBED_ENTRY,
            enabled: true,
          },
        ],
      },
    });
  });

  it("scrubs the system temp directory in every spelling, and keeps a scratch root under it", async () => {
    const rawDir = NodePath.join(ROOT, "raw-tmp");
    const launcher = makeTeeLauncher({ realBinary: COUNTERPART, rawDir });
    const tmp = NodeOS.tmpdir();
    const resolved = NodeFS.realpathSync(tmp);

    const run = converse(launcher, [...STREAM_ARGS, "--add-dir", `${tmp}/claude-attachments-x`], {
      cwd: REPO,
    });
    await run.awaitLine(typed("ready"));
    run.send({
      type: "note",
      paths: [`${tmp}/claude-attachments-x/shot.png`, `${resolved}/other`, tmp, `${tmp}ish`],
    });
    await run.awaitLine(typed("echo"));
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);

    const fixtures = NodePath.join(ROOT, "fixtures-tmp");
    finalizeSdkStreamRecording({
      kind: "sample",
      scenario: "tmp",
      rawDir,
      description: "an ordinary node program, for the finaliser's own test",
      cliVersion: "9.9.9",
      sdkVersion: "0.0.0",
      model: "none",
      prompts: [],
      fixturesRoot: fixtures,
    });

    const [stream] = loadSdkStreamRecording("sample", "tmp", fixtures).invocations;
    // The scratch root lives under the temp directory and is the longer
    // spelling, so it stays a scratch root.
    expect(stream!.cwd).toBe("<SCRATCH>/repo");
    expect(stream!.argv.at(-1)).toBe("<TMP>/claude-attachments-x");
    const echoed = stream!.frames.find((frame) => typed("echo")(frame.data))!.data;
    expect(echoed).toMatchObject({
      message: {
        // A name that merely starts with the temp directory's is not in it.
        paths: ["<TMP>/claude-attachments-x/shot.png", "<TMP>/other", "<TMP>", `${tmp}ish`],
      },
    });
    const written = NodeFS.readdirSync(NodePath.join(fixtures, "sample", "tmp"))
      .map((name) => NodeFS.readFileSync(NodePath.join(fixtures, "sample", "tmp", name), "utf8"))
      .join("\n");
    expect(written).not.toContain(`${resolved}/`);
    expect(written).not.toContain(`${tmp}/`);
  });

  it("is required to name its transport, having no legacy layout", () => {
    const fixtures = NodePath.join(ROOT, "fixtures-untyped");
    NodeFS.mkdirSync(NodePath.join(fixtures, "sample", "untyped"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(fixtures, "sample", "untyped", "manifest.json"),
      JSON.stringify({ real: true, formatVersion: 1 }),
    );
    expect(() => readManifest("sample", "untyped", fixtures)).toThrow(/names no transport/);
  });
});
