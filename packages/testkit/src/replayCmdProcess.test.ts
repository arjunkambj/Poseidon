/**
 * The replayer, spawned as a real process against real recordings.
 *
 * Nothing is mocked here: the binary runs, writes a transcript into a temp
 * `HOME`, invokes a hook script through the system shell, and exits. If this
 * passes, the recordings can stand in for the CLI everywhere the connector is
 * tested.
 */

import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadRecording,
  recordingNames,
  replayConfig,
  RECORDINGS_DIR,
  REPLAY_BINARY,
} from "./replayCmdProcess";

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly chunks: ReadonlyArray<number>;
}

const run = (
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string> },
): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [REPLAY_BINARY, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const chunks: Array<number> = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      chunks.push(chunk.length);
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolve({ stdout, stderr, code: code ?? -1, chunks }));
  });

/** A throwaway workspace and HOME, thrown away again by the caller. */
const sandbox = (): { readonly root: string; readonly home: string; readonly cwd: string } => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "replay-cmd-test-"));
  const home = NodePath.join(root, "home");
  const cwd = NodePath.join(root, "repo");
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
};

const frameTypes = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as { type: string; event?: { type?: string } };
      return parsed.type === "event" ? (parsed.event?.type ?? "event") : parsed.type;
    });

/**
 * Recordings the CLI refused before it wrote a single frame, and why. They
 * carry their evidence on stderr and in the exit code, and their manifest's
 * model is the one the recorder asked for.
 */
const NO_FRAMES: Readonly<Record<string, string>> = {
  "generate-text-effort": "--effort on a model that takes none: refused on stderr, exit 1",
};

describe("loadRecording", () => {
  it("reads every recording on disk", () => {
    const names = recordingNames();
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) {
      const recording = loadRecording(name);
      // A version, not one pinned version: the connector runs whatever the
      // operator has installed and recordings are taken as that moves.
      expect(recording.cliVersion, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(recording.turns.length).toBeGreaterThan(0);
      for (const turn of recording.turns) {
        // Every recording is a real run with real argv and real frames.
        expect(turn.connectorArgs).toContain("--output-format");
        if (NO_FRAMES[name] === undefined) {
          expect(turn.frames.length, name).toBeGreaterThan(0);
        } else {
          expect(turn.frames, name).toEqual([]);
          expect(turn.stderr.trim(), name).not.toBe("");
        }
      }
    }
  });

  it("refuses a directory that is not a recording", () => {
    expect(() => loadRecording("not-a-scenario")).toThrow();
  });

  /**
   * `fixtures/cmd/README.md` promises that each manifest names the model its own
   * frames name, so a recording made on a different model says so instead of
   * inheriting the table. A placeholder like "the CLI's configured default" — what
   * the recorder wrote before it learned to read the frames — breaks that promise
   * and hides which model a fixture's wording came from.
   */
  it("names the model each recording's own frames name", () => {
    for (const name of recordingNames().filter((name) => NO_FRAMES[name] === undefined)) {
      const recording = loadRecording(name);
      const fromFrames = new Set(
        recording.turns
          .flatMap((turn) => turn.frames)
          .flatMap((frame) => {
            const event = (frame as { event?: { type?: string; model?: string } }).event;
            return event?.type === "model_request_start" && event.model !== undefined
              ? [event.model]
              : [];
          }),
      );
      expect(fromFrames.size, `${name}: no model_request_start frame to check against`).toBe(1);
      expect(recording.model, `${name}: manifest model`).toBe([...fromFrames][0]);
    }
  });
});

describe("the recorded non-model surfaces", () => {
  it("answers status, --list-models and --version from the probe recording", async () => {
    const box = sandbox();
    try {
      const env = { HOME: box.home };
      // The probe recording is the CLI answering for itself, so it is also
      // what says which version those answers came from.
      const probeVersion = (
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(RECORDINGS_DIR, "probe", "manifest.json"), "utf8"),
        ) as { cliVersion: string }
      ).cliVersion;
      const status = await run(["status", "--json"], { cwd: box.cwd, env });
      expect(JSON.parse(status.stdout).authenticated).toBe(true);
      expect(JSON.parse(status.stdout).version).toBe(probeVersion);

      const models = await run(["--list-models"], { cwd: box.cwd, env });
      expect(models.stdout).toContain("70 models");

      const version = await run(["--version"], { cwd: box.cwd, env });
      expect(version.stdout.trim()).toBe(probeVersion);
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });

  /**
   * The id comes from the probe recording's own argv, not from a constant in
   * the replayer — so this reads it the same way and a re-recording with a
   * different made-up model needs no edit here either.
   */
  it("rejects the model the probe recording was rejected for", async () => {
    const probe = JSON.parse(
      NodeFS.readFileSync(NodePath.join(RECORDINGS_DIR, "probe", "manifest.json"), "utf8"),
    ) as { probes: ReadonlyArray<{ name: string; args: ReadonlyArray<string>; exitCode: number }> };
    const recorded = probe.probes.find((entry) => entry.name === "invalid-model");
    const model = recorded?.args[recorded.args.indexOf("--model") + 1];
    expect(model).toBeDefined();

    const box = sandbox();
    try {
      const result = await run(["-p", "hi", "--model", model!], {
        cwd: box.cwd,
        env: { HOME: box.home },
      });
      expect(result.code).toBe(recorded!.exitCode);
      expect(result.stderr).toContain("unknown model");
      expect(result.stdout).toBe("");
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });
});

describe("replaying a turn", () => {
  it("puts the recorded frames back in the recorded chunks", async () => {
    const box = sandbox();
    try {
      const recording = loadRecording("text");
      const config = replayConfig("text", { home: box.home, turn: 0 });
      const result = await run(recording.turns[0]!.connectorArgs, {
        cwd: box.cwd,
        env: config.extraEnv,
      });

      expect(result.code).toBe(0);
      expect(frameTypes(result.stdout)).toEqual(
        recording.turns[0]!.frames.map((frame) => {
          const parsed = frame as { type: string; event?: { type?: string } };
          return parsed.type === "event" ? (parsed.event?.type ?? "event") : parsed.type;
        }),
      );
      // The `session: <uuid>` line the connector reads the id from.
      expect(result.stderr).toContain(`session: ${recording.turns[0]!.sessionId}`);
      // Every byte, not just every frame.
      expect(result.stdout.split("\n").filter((line) => line.length > 0)).toHaveLength(
        recording.turns[0]!.frames.length,
      );
      // The replay writes in the recorded chunk boundaries rather than one
      // block, so the connector's splitter meets the same partial lines. How
      // many reads that turns into on this side is the kernel's business, not
      // something to assert on.
      expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });

  it("writes the transcript where the harness wrote it, not where the slug guesses", async () => {
    const box = sandbox();
    try {
      const recording = loadRecording("shell-yolo");
      const config = replayConfig("shell-yolo", { home: box.home, turn: 0 });
      await run(recording.turns[0]!.connectorArgs, { cwd: box.cwd, env: config.extraEnv });

      const projects = NodePath.join(box.home, ".commandcode", "projects");
      const directories = NodeFS.readdirSync(projects);
      expect(directories).toHaveLength(1);
      // Not the connector's slug of this cwd — the recorded directory name.
      const slug = box.cwd.toLowerCase().replaceAll("/", "-").replace(/^-/, "");
      expect(directories[0]).not.toBe(slug);

      const transcript = NodePath.join(
        projects,
        directories[0]!,
        `${recording.turns[0]!.sessionId}.jsonl`,
      );
      const written = NodeFS.readFileSync(transcript, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(written).toHaveLength(recording.turns[0]!.transcript.length);
      expect(JSON.parse(written[0]!).type).toBe("session");
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });

  it("calls the project's PreToolUse hook with the recorded payload and waits", async () => {
    const box = sandbox();
    try {
      // A hook that records what it was asked and answers the way the
      // recording's hook answered.
      const log = NodePath.join(box.root, "hook.log");
      const hook = NodePath.join(box.root, "hook.mjs");
      NodeFS.writeFileSync(
        hook,
        [
          "import * as fs from 'node:fs';",
          "let data = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (c) => { data += c; });",
          "process.stdin.on('end', () => {",
          `  fs.appendFileSync(${JSON.stringify(log)}, data + '\\n');`,
          "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));",
          "});",
        ].join("\n"),
        { encoding: "utf8", mode: 0o700 },
      );
      NodeFS.mkdirSync(NodePath.join(box.cwd, ".commandcode"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(box.cwd, ".commandcode", "settings.local.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: ".*",
                hooks: [{ type: "command", command: `${process.execPath} ${hook}`, timeout: 590 }],
              },
            ],
          },
        }),
        "utf8",
      );

      const recording = loadRecording("shell-yolo");
      const config = replayConfig("shell-yolo", { home: box.home, turn: 0 });
      await run(recording.turns[0]!.connectorArgs, { cwd: box.cwd, env: config.extraEnv });

      const asked = NodeFS.readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { tool_name: string; tool_input: { command?: string } });
      expect(asked).toHaveLength(recording.turns[0]!.hooks.length);
      expect(asked[0]!.tool_name).toBe("shell_command");
      expect(asked[0]!.tool_input.command).toBe("cat note.txt");
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });

  /**
   * The ordering the translator is built on: stdout goes out as the run
   * produces it, and the transcript is not there when the run starts, appears
   * partway through, and takes its last append with `run_end`. A replay that
   * wrote the whole transcript before its first byte of stdout — which is what
   * this one used to do — hands the tailer a finished file to skip past, so no
   * recording-driven test ever exercises the live path or the late `costUsd`
   * it carries.
   *
   * The observer is the hook: it runs inside the replay, at a point the
   * recording fixed, and reports how large each file was at that moment.
   * stdout goes to a file so the answer is the child's own write ordering and
   * not this process's scheduling.
   */
  it("writes stdout as it goes, with the transcript still unwritten", async () => {
    const box = sandbox();
    try {
      const log = NodePath.join(box.root, "size.log");
      const hook = NodePath.join(box.root, "size-hook.mjs");
      NodeFS.writeFileSync(
        hook,
        [
          "import * as fs from 'node:fs';",
          "let data = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (c) => { data += c; });",
          "process.stdin.on('end', () => {",
          "  const at = JSON.parse(data).transcript_path;",
          "  let bytes = -1;",
          "  try { bytes = fs.statSync(at).size; } catch { bytes = -1; }",
          "  let out = -1;",
          "  try { out = fs.statSync(process.env.REPLAY_STDOUT_FILE).size; } catch { out = -1; }",
          `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at, bytes, out }) + '\\n');`,
          "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));",
          "});",
        ].join("\n"),
        { encoding: "utf8", mode: 0o700 },
      );
      NodeFS.mkdirSync(NodePath.join(box.cwd, ".commandcode"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(box.cwd, ".commandcode", "settings.local.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: ".*",
                hooks: [{ type: "command", command: `${process.execPath} ${hook}`, timeout: 590 }],
              },
            ],
          },
        }),
        "utf8",
      );

      const recording = loadRecording("shell-yolo");
      const config = replayConfig("shell-yolo", { home: box.home, turn: 0 });
      const stdoutFile = NodePath.join(box.root, "stdout.ndjson");
      const fd = NodeFS.openSync(stdoutFile, "w");
      const child = spawn(process.execPath, [REPLAY_BINARY, ...recording.turns[0]!.connectorArgs], {
        cwd: box.cwd,
        env: { ...process.env, ...config.extraEnv, REPLAY_STDOUT_FILE: stdoutFile },
        stdio: ["ignore", fd, "ignore"],
      });
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      NodeFS.closeSync(fd);

      const seen = NodeFS.readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { at: string; bytes: number; out: number });
      expect(seen.length).toBeGreaterThan(0);
      // Frames were already on stdout when this hook ran...
      expect(seen[0]!.out).toBeGreaterThan(0);
      // ...and the transcript had not been written at all: the recording's own
      // growth samples put its first flush after the frame this hook gates.
      expect(seen[0]!.bytes).toBe(-1);
      // By the end the whole transcript is there, and so is every frame.
      expect(
        NodeFS.readFileSync(seen[0]!.at, "utf8")
          .split("\n")
          .filter((line) => line.length > 0),
      ).toHaveLength(recording.turns[0]!.transcript.length);
      expect(
        NodeFS.readFileSync(stdoutFile, "utf8")
          .split("\n")
          .filter((line) => line.length > 0),
      ).toHaveLength(recording.turns[0]!.frames.length);
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });

  it("exits with the recorded code", async () => {
    const box = sandbox();
    try {
      // `--max-turns` exhausted: exit 8, the code the connector maps.
      const recording = loadRecording("max-turns");
      const config = replayConfig("max-turns", { home: box.home, turn: 0 });
      const result = await run(recording.turns[0]!.connectorArgs, {
        cwd: box.cwd,
        env: config.extraEnv,
      });
      expect(result.code).toBe(8);
      expect(recording.turns[0]!.exitCode).toBe(8);
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });

  it("plays successive recorded turns on successive spawns", async () => {
    const box = sandbox();
    try {
      const recording = loadRecording("resume");
      const config = replayConfig("resume", { home: box.home });

      const first = await run(recording.turns[0]!.connectorArgs, {
        cwd: box.cwd,
        env: config.extraEnv,
      });
      const second = await run(recording.turns[1]!.connectorArgs, {
        cwd: box.cwd,
        env: config.extraEnv,
      });

      // Same session id across both, and the second really is the second
      // recorded run — it is the one that remembers the word.
      expect(first.stderr).toContain(recording.turns[0]!.sessionId!);
      expect(second.stderr).toContain(recording.turns[1]!.sessionId!);
      expect(second.stdout).not.toBe(first.stdout);
      expect(frameTypes(second.stdout)).toContain("thinking_start");
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });

  it("honours SIGINT on the recording that was itself interrupted", async () => {
    const box = sandbox();
    try {
      const recording = loadRecording("interrupt");
      expect(recording.turns[0]!.interrupted).toBe(true);
      const config = replayConfig("interrupt", { home: box.home, turn: 0 });

      const child = spawn(process.execPath, [REPLAY_BINARY, ...recording.turns[0]!.connectorArgs], {
        cwd: box.cwd,
        env: { ...process.env, ...config.extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      const ended = new Promise<number>((resolve) => {
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          // The recorded run was working when the signal arrived; so is this
          // one — it waits rather than inventing an ending it never had.
          if (stdout.includes("thinking_delta")) {
            child.kill("SIGINT");
          }
        });
        child.once("close", (code) => resolve(code ?? -1));
      });

      expect(await ended).toBe(130);
      // No run_end and no result line: SIGINT leaves the run unfinished.
      expect(frameTypes(stdout)).not.toContain("run_end");
      expect(frameTypes(stdout)).not.toContain("result");
    } finally {
      NodeFS.rmSync(box.root, { recursive: true, force: true });
    }
  });
});
