/**
 * The stdio tee and the `stdio-jsonrpc` finaliser, run as real processes.
 *
 * The far end of the pipes is an ordinary node program written into a temp
 * directory (`stdioCounterpart.ts`), speaking JSON-RPC when its argv holds
 * `app-server` — not a harness and not a stand-in for one: these tests are
 * about lines, directions and scrubbing. The recordings they make live and
 * die in that temp directory.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { RecordedFrame } from "./recording";
import { loadSdkStreamRecording, makeTeeLauncher } from "./sdkStreamRecording";
import { converse, writeCounterpart } from "./stdioCounterpart";
import {
  finalizeStdioJsonRpcRecording,
  loadStdioJsonRpcRecording,
  STDIO_JSONRPC_PROBE_MARKER,
} from "./stdioJsonRpcRecording";

const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stdio-jsonrpc-tee-"));
const REPO = NodePath.join(ROOT, "scratch", "repo");
const PROBE_CWD = NodePath.join(ROOT, "probe-cwd");
NodeFS.mkdirSync(REPO, { recursive: true });
NodeFS.mkdirSync(PROBE_CWD, { recursive: true });
const COUNTERPART = writeCounterpart(NodePath.join(ROOT, "bin"));
/** A config directory with nothing in it, so only the named entries are numbered. */
const EMPTY_CONFIG = NodePath.join(ROOT, "config-dir");
NodeFS.mkdirSync(EMPTY_CONFIG, { recursive: true });

afterAll(() => {
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
});

interface Line {
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

const responseTo =
  (id: unknown) =>
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

/** A frame's direction and what kind of JSON-RPC message it holds. */
const shape = (frame: RecordedFrame): string => {
  const data = frame.data as Line;
  const kind =
    data.method === undefined
      ? `response ${String(data.id)}`
      : data.id === undefined
        ? `notification ${data.method}`
        : `request ${data.method} ${String(data.id)}`;
  return `${frame.dir} ${frame.channel} ${kind}`;
};

describe("the stdio tee under JSON-RPC", () => {
  it("captures requests, responses and notifications both ways, in the order they crossed", async () => {
    const rawDir = NodePath.join(ROOT, "raw-order");
    const run = converse(makeTeeLauncher({ realBinary: COUNTERPART, rawDir }), ["app-server"], {
      cwd: REPO,
    });
    run.send({ id: 0, method: "initialize", params: {} });
    await run.awaitLine(responseTo(0));
    run.send({ method: "initialized" });
    await run.awaitLine(notificationOf("echo"));
    run.send({ id: 1, method: "ask", params: { command: "ls" } });
    const asked = (await run.awaitLine(requestOf("approve"))) as { id: number };
    run.send({ id: asked.id, result: { decision: "accept" } });
    await run.awaitLine(notificationOf("answered"));
    run.child.stdin.end();
    expect((await run.exited).code).toBe(0);

    const frames = NodeFS.readFileSync(NodePath.join(rawDir, "invocation-1.ndjson"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RecordedFrame);
    expect(frames.map(shape)).toEqual([
      "to-harness stdin request initialize 0",
      "from-harness stdout response 0",
      "to-harness stdin notification initialized",
      "from-harness stdout notification echo",
      "to-harness stdin request ask 1",
      "from-harness stdout response 1",
      "from-harness stdout request approve 0",
      "to-harness stdin response 0",
      "from-harness stdout notification answered",
    ]);
  });
});

describe("finalizeStdioJsonRpcRecording", () => {
  const home = NodeOS.homedir();
  const tmp = NodeOS.tmpdir();
  const bearer = "0123456789abcdef".repeat(3);
  const hostname = NodeOS.hostname();

  /** A login status, a probe's handshake and a session, through one tee. */
  const record = async (rawDir: string, extra: Record<string, unknown>): Promise<void> => {
    const launcher = makeTeeLauncher({ realBinary: COUNTERPART, rawDir });
    const status = converse(launcher, ["login", "status"], { cwd: PROBE_CWD });
    expect((await status.exited).code).toBe(0);

    const probe = converse(launcher, ["app-server", STDIO_JSONRPC_PROBE_MARKER], {
      cwd: PROBE_CWD,
    });
    probe.send({ id: 0, method: "initialize", params: {} });
    await probe.awaitLine(responseTo(0));
    probe.child.stdin.end();
    expect((await probe.exited).code).toBe(0);

    const session = converse(launcher, ["app-server"], { cwd: REPO });
    session.send({
      id: 0,
      method: "initialize",
      params: {
        account: { email: "someone@example.org", accountId: "acct-private-0001" },
        workspaceRouting: { chatgptAccountId: "5ee21f34-0000-4001-87af-000000000001" },
        headers: { Authorization: `Bearer ${bearer}`, access_token: "short" },
        mcpServers: { "private-server": { command: `${home}/bin/private-server` } },
        text: `someone@example.org on ${hostname} reads ${home}/notes and ${tmp}/scratch-file`,
        ...extra,
      },
    });
    await session.awaitLine(responseTo(0));
    session.send({
      method: "mcpServer/status",
      params: { name: "private-server", status: "ready", note: "private-server started" },
    });
    await session.awaitLine(notificationOf("echo"));
    session.child.stdin.end();
    expect((await session.exited).code).toBe(0);
  };

  it("scrubs the account, credentials, home, scratch, temp dir, host and named entries", async () => {
    const rawDir = NodePath.join(ROOT, "raw-scrub");
    await record(rawDir, {});
    const fixtures = NodePath.join(ROOT, "fixtures");
    const dir = finalizeStdioJsonRpcRecording({
      kind: "sample",
      scenario: "scrubbed",
      rawDir,
      description: "an ordinary node program, for the finaliser's own test",
      cliVersion: "9.9.9",
      model: "none",
      prompts: [`look in ${home}`],
      fixturesRoot: fixtures,
      configDir: EMPTY_CONFIG,
      operatorNames: ["private-server"],
    });

    const written = NodeFS.readdirSync(dir)
      .map((name) => NodeFS.readFileSync(NodePath.join(dir, name), "utf8"))
      .join("\n");
    for (const leaked of [
      bearer,
      "someone@example.org",
      "acct-private-0001",
      "5ee21f34-0000-4001-87af-000000000001",
      "private-server",
      `${home}/`,
      `${tmp}/`,
      NodeFS.realpathSync(tmp),
      hostname,
    ]) {
      expect(written).not.toContain(leaked);
    }

    const recording = loadStdioJsonRpcRecording("sample", "scrubbed", fixtures);
    expect(recording.manifest).toMatchObject({
      formatVersion: 1,
      kind: "sample",
      transport: "stdio-jsonrpc",
      scenario: "scrubbed",
      cliVersion: "9.9.9",
      real: true,
      prompts: ["look in <HOME>"],
    });
    expect(recording.manifest).not.toHaveProperty("sdkVersion");
    expect(recording.invocations.map((invocation) => invocation.argv)).toEqual([
      ["login", "status"],
      ["app-server", STDIO_JSONRPC_PROBE_MARKER],
      ["app-server"],
    ]);

    const [status, probe, session] = recording.invocations;
    expect(status!.frames[0]!.data).toBe("Logged in as user@example.com");
    // The scratch root comes from the session's run, not the probe's.
    expect(probe!.cwd).toMatch(/^<TMPDIR>\/stdio-jsonrpc-tee-[^/]+\/probe-cwd$/);
    expect(session!.cwd).toBe("<SCRATCH>/repo");

    const [, answer, , status2] = session!.frames.map((frame) => frame.data);
    expect(answer).toMatchObject({
      id: 0,
      result: {
        cwd: "<SCRATCH>/repo",
        tmp: "<TMPDIR>",
        params: {
          account: { email: "user@example.com", accountId: "<ACCOUNT>" },
          workspaceRouting: { chatgptAccountId: "00000000-0000-0000-0000-000000000000" },
          headers: { Authorization: "<REDACTED>", access_token: "<REDACTED>" },
          mcpServers: { "user-skill-1": { command: "<HOME>/bin/user-skill-1" } },
          text: "user@example.com on <HOST> reads <HOME>/notes and <TMPDIR>/scratch-file",
        },
      },
    });
    expect(status2).toMatchObject({
      method: "echo",
      params: {
        method: "mcpServer/status",
        params: { name: "user-skill-1", status: "ready", note: "user-skill-1 started" },
      },
    });

    expect(() => loadSdkStreamRecording("sample", "scrubbed", fixtures)).toThrow(
      /recorded over stdio-jsonrpc, not sdk-stream/,
    );
  });

  it("scrubs a temp directory only as a whole path segment", async () => {
    const rawDir = NodePath.join(ROOT, "raw-segment");
    const fakeTmp = NodePath.join(ROOT, "fake-tmp");
    await record(rawDir, { paths: [`${fakeTmp}/inside`, `${fakeTmp}-sibling/file`, fakeTmp] });
    const fixtures = NodePath.join(ROOT, "fixtures-segment");
    finalizeStdioJsonRpcRecording({
      kind: "sample",
      scenario: "segment",
      rawDir,
      description: "an ordinary node program, for the finaliser's own test",
      cliVersion: "9.9.9",
      model: "none",
      prompts: [],
      fixturesRoot: fixtures,
      configDir: EMPTY_CONFIG,
      tmpdir: fakeTmp,
    });
    const session = loadStdioJsonRpcRecording("sample", "segment", fixtures).invocations[2]!;
    expect(session.frames[1]!.data).toMatchObject({
      result: {
        params: { paths: ["<TMPDIR>/inside", `${fakeTmp}-sibling/file`, "<TMPDIR>"] },
      },
    });
  });
});
