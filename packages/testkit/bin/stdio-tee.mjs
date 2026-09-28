#!/usr/bin/env node
/**
 * Stands between an SDK and the CLI it drives, and writes down everything that
 * crosses the pipes.
 *
 * An SDK that speaks to its harness over stdio NDJSON — messages and
 * `control_request` / `control_response` on stdout and stdin — is recorded
 * here, at the process boundary, rather than inside the SDK: what lands on disk
 * is then exactly what the real CLI said and was told, whichever SDK version or
 * connector code produced the other half. A harness that speaks JSON-RPC over
 * stdio is recorded here too: the tee frames lines, whatever they hold.
 *
 * It is launched by the `#!/bin/sh` launcher `makeTeeLauncher` writes
 * (`packages/testkit/src/sdkStreamRecording.ts`), which a recording points the
 * connector's binary path at:
 *
 *     node stdio-tee.mjs <config.json> <the argv the SDK passed>
 *
 * `config.json` names the real binary and the raw directory. The tee spawns the
 * real binary with the identical argv, cwd and environment, pipes all three
 * streams through unchanged, and appends one frame per line to
 * `invocation-<n>.ndjson`:
 *
 *     { "dir": "to-harness" | "from-harness",
 *       "channel": "stdin" | "stdout" | "stderr",
 *       "at": <ms since the tee started>,
 *       "data": <the parsed JSON line, or the raw string when it is not JSON
 *                or is a JSON string alone> }
 *
 * Each frame is appended synchronously, so a SIGKILL of the process group loses
 * nothing already seen. `invocation-<n>.json` holds the argv and cwd from the
 * start and gains the exit code and signal when the harness exits. Environment
 * values are never written anywhere.
 *
 * The real binary stays in the tee's own process group — it is not detached —
 * so a connector that kills the group it spawned takes both. SIGINT and SIGTERM
 * sent to the tee alone are forwarded.
 *
 * Plain node, no dependencies, never imported by the server bundle.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const [configPath, ...argv] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const started = Date.now();

/**
 * The next free invocation number in the raw directory. Claiming the metadata
 * file with an exclusive create is what keeps two launches that race — a probe
 * beside a session — from sharing a number.
 */
const claimInvocation = () => {
  for (let n = 1; ; n += 1) {
    const file = path.join(config.rawDir, `invocation-${n}.json`);
    try {
      fs.writeFileSync(
        file,
        `${JSON.stringify({ argv, cwd: process.cwd(), exitCode: null, signal: null }, null, 2)}\n`,
        { flag: "wx" },
      );
      return n;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }
};

fs.mkdirSync(config.rawDir, { recursive: true });
const invocation = claimInvocation();
const framesFile = path.join(config.rawDir, `invocation-${invocation}.ndjson`);
const metaFile = path.join(config.rawDir, `invocation-${invocation}.json`);

const record = (dir, channel, line) => {
  let data = line;
  try {
    const parsed = JSON.parse(line);
    // A line that is only a JSON string — an array element of pretty-printed
    // output, say — stays the raw line: parsed, it would lose its quotes and
    // indentation, and a replay prints a string frame as it stands.
    if (typeof parsed !== "string") data = parsed;
  } catch {
    // Not JSON: kept as the raw line.
  }
  fs.appendFileSync(
    framesFile,
    `${JSON.stringify({ dir, channel, at: Date.now() - started, data })}\n`,
    "utf8",
  );
};

/** Splits a byte stream into lines, recording each whole one as it completes. */
const lineRecorder = (dir, channel) => {
  // A decoder per stream, so a character split across two chunks stays whole.
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return {
    push: (chunk) => {
      pending += decoder.write(chunk);
      let at = pending.indexOf("\n");
      while (at !== -1) {
        record(dir, channel, pending.slice(0, at));
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    },
    flush: () => {
      pending += decoder.end();
      if (pending.length > 0) {
        record(dir, channel, pending);
        pending = "";
      }
    },
  };
};

const child = spawn(config.realBinary, argv, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const stdinLines = lineRecorder("to-harness", "stdin");
const stdoutLines = lineRecorder("from-harness", "stdout");
const stderrLines = lineRecorder("from-harness", "stderr");

// A harness that exits while its stdin is still being written to is not an
// error of the tee's; the bytes had nowhere to go in the original either.
child.stdin.on("error", () => {});
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

process.stdin.on("data", (chunk) => {
  stdinLines.push(chunk);
  child.stdin.write(chunk);
});
process.stdin.on("end", () => {
  stdinLines.flush();
  child.stdin.end();
});

child.stdout.on("data", (chunk) => {
  stdoutLines.push(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderrLines.push(chunk);
  process.stderr.write(chunk);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.once("error", (error) => {
  process.stderr.write(`stdio-tee: could not start ${config.realBinary}: ${error.message}\n`);
  process.exit(127);
});

child.once("close", (code, signal) => {
  stdoutLines.flush();
  stderrLines.flush();
  fs.writeFileSync(
    metaFile,
    `${JSON.stringify({ argv, cwd: process.cwd(), exitCode: code, signal }, null, 2)}\n`,
    "utf8",
  );
  // Leave the way the harness left, once whatever it printed has drained.
  const finish = () => {
    if (signal !== null) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  };
  process.stdout.write("", () => process.stderr.write("", finish));
});
