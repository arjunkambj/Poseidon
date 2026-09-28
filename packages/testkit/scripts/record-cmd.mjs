#!/usr/bin/env node
/**
 * Records real Command Code CLI runs into `packages/testkit/fixtures/cmd/`.
 *
 * This is the only thing in the repo that knows what the harness actually
 * does. Every connector test replays what this captured — nothing about the
 * CLI is invented anywhere else. It is run by hand (it spends the operator's
 * plan), never from CI:
 *
 *     node packages/testkit/scripts/record-cmd.mjs <scenario> [--model <id>]
 *     node packages/testkit/scripts/record-cmd.mjs --list
 *
 * Each run gets a throwaway git repo under a scratch root, is spawned with the
 * *same argv and env the connector builds* (packages/connector-cmd/src/spawn.ts
 * and session.ts), and is watched from three sides at once: stdout chunks with
 * arrival order, stderr, the session transcript as it grows on disk, the plans
 * index, and every PreToolUse hook invocation — through the very same
 * `settings.local.json` mechanism the connector installs.
 *
 * Recordings are scrubbed before they land: absolute paths become placeholders,
 * the account name becomes "user", anything token-shaped is redacted.
 */

import { spawn } from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { COLOURS, HOOK_SOURCE, MCP_SERVER_SOURCE, solidPng } from "./record-assets.mjs";
import { SCENARIOS, scenarioNames } from "./record-scenarios.mjs";

const CLI_PACKAGE = "command-code@latest";
const TRANSCRIPT_POLL_MS = 25;

/**
 * The only models a recording may be made on. `cmd --list-models` offers about
 * seventy and most of them bill the operator's card; these three are the ones
 * the operator authorised — the account default, which is cheap and good at
 * tool use, and two free tiers. Recording is spending, so a `--model` outside
 * this list stops the run rather than discovering the price afterwards.
 */
const AUTHORISED_MODELS = [
  "meta/muse-spark-1.3-contributor",
  "poolside/laguna-s-2.1-free",
  "inclusionai/ling-3.0-flash-sante:free",
];

/**
 * The binary the connector would pick (probe.ts `resolveBinary`): `cmd` on
 * PATH or in a global bin dir, else the `@latest` npx fallback. Recording
 * through the same resolution is what makes the fixtures describe the
 * operator's real install rather than a package npx happened to download.
 */
const resolveBinary = () => {
  const dirs = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    NodePath.join(NodeOS.homedir(), ".bun", "bin"),
    NodePath.join(NodeOS.homedir(), ".local", "share", "pnpm"),
    NodePath.join(NodeOS.homedir(), ".npm-global", "bin"),
  ];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, "cmd");
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      if (NodeFS.statSync(candidate).isFile()) {
        return { command: candidate, prefixArgs: [], display: candidate };
      }
    } catch {
      /* not here */
    }
  }
  return { command: "npx", prefixArgs: ["-y", CLI_PACKAGE], display: `npx ${CLI_PACKAGE}` };
};

/** Runs the binary for its stdout. Used for the two free, non-model surfaces. */
const askBinary = (binary, args) =>
  new Promise((resolve) => {
    const child = spawn(binary.command, [...binary.prefixArgs, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.once("exit", () => resolve(out.trim()));
    child.once("error", () => resolve(""));
  });

/** `cmd --version`, asked with --no-auto-update so asking cannot upgrade it. */
const binaryVersion = (binary) =>
  askBinary(binary, ["--version", "--no-auto-update"]).then((out) => out || "unknown");

/** The account name the recordings must not carry, asked of the CLI itself. */
const binaryAccount = (binary) =>
  askBinary(binary, ["status", "--json"]).then((out) => {
    try {
      return JSON.parse(out).user;
    } catch {
      return undefined;
    }
  });

const ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../..", import.meta.url)));
const FIXTURE_ROOT = NodePath.join(ROOT, "packages", "testkit", "fixtures", "cmd");

// ── argv/env: mirrors of packages/connector-cmd/src/spawn.ts ───

/** Mirror of `buildArgs` — keep in step with spawn.ts or recordings lie. */
const buildArgs = (input) => {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--verbose",
    "-t",
    "--skip-onboarding",
    "--no-auto-update",
  ];
  if (input.noSession === true) {
    args.push("--no-session");
  } else if (input.sessionId !== undefined) {
    args.push("--session", input.sessionId);
    if (input.forkSession === true) args.push("--fork-session");
  }
  if (input.model !== undefined) args.push("--model", input.model);
  if (input.effort !== undefined) args.push("--effort", input.effort);
  if (input.permissionMode !== undefined) args.push("--permission-mode", input.permissionMode);
  if (input.yolo === true) args.push("--yolo");
  if (input.maxTurns !== undefined) args.push("--max-turns", String(input.maxTurns));
  for (const dir of input.addDir ?? []) args.push("--add-dir", dir);
  for (const tool of input.toolsEnable ?? []) args.push("--tools-enable", tool);
  // Not part of `buildArgs`: a scenario that is probing a flag the connector
  // does not send yet appends it here, so the mirror above stays an exact copy.
  for (const extra of input.extraArgs ?? []) args.push(extra);
  return args;
};

/**
 * Mirror of `spawn.ts` `TOOLS_ENABLED`: the withheld tools every turn asks for
 * by name. A scenario recording what a run looks like *without* them sets
 * `toolsEnable: []`.
 */
const TOOLS_ENABLED = ["ask_user_question"];

const BASE_ENV = new Set([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);
const PASS_PREFIXES = ["LC_", "POSEIDON_"];
const DROP_PREFIXES = ["POSEIDON_SERVER_", "ANTHROPIC_", "OPENAI_"];

const isAllowed = (name) =>
  !DROP_PREFIXES.some((p) => name.startsWith(p)) &&
  (BASE_ENV.has(name) ||
    name === "COMMAND_CODE_API_KEY" ||
    PASS_PREFIXES.some((p) => name.startsWith(p)));

/** Mirror of `envAllowlist`. */
const envAllowlist = (env, extra = {}) => {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isAllowed(name)) out[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (isAllowed(name)) out[name] = value;
  }
  return out;
};

/** Mirror of transcript.ts `slugFor`. */
const slugFor = (cwd) => {
  const slug = cwd.toLowerCase().replaceAll("/", "-");
  return slug.startsWith("-") ? slug.slice(1) : slug;
};

// ── scratch workspace ──────────────────────────────────────────

/** A trivial stdio MCP server, so the MCP scenario needs nothing installed. */
const makeWorkspace = async (scratch, seed) => {
  const repo = NodePath.join(scratch, "repo");
  NodeFS.mkdirSync(repo, { recursive: true });
  for (const [relative, content] of Object.entries(seed ?? {})) {
    const target = NodePath.join(repo, relative);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content, "utf8");
  }
  const git = async (...args) => {
    await once(
      spawn("git", args, {
        cwd: repo,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "rec", GIT_AUTHOR_EMAIL: "rec@example.invalid" },
      }),
    );
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "rec@example.invalid");
  await git("config", "user.name", "rec");
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed", "--allow-empty");
  return repo;
};

const once = (child) =>
  new Promise((resolve) => {
    child.once("exit", (code) => resolve(code ?? -1));
    child.once("error", () => resolve(-1));
  });

/**
 * Files the scenario wants beside the repo rather than in it — the image
 * attachment lives where the server stages one, outside the workspace root,
 * which is the whole reason `--add-dir` is part of the design.
 */
const writeScratchSeed = (scratch, seed) => {
  for (const [relative, content] of Object.entries(seed ?? {})) {
    const target = NodePath.join(scratch, relative);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    if (typeof content === "string") {
      NodeFS.writeFileSync(target, content, "utf8");
      continue;
    }
    const colour = COLOURS[content.png];
    if (colour === undefined) {
      throw new Error(`unknown seed colour ${content.png}`);
    }
    NodeFS.writeFileSync(target, solidPng(...colour));
  }
};

/**
 * Registers the recording MCP server in the throwaway repo's own `.mcp.json`,
 * through the CLI's own command rather than by guessing the file format.
 */
const installMcpServer = async (binary, repo, scratch) => {
  const serverPath = NodePath.join(scratch, "mcp-server.mjs");
  NodeFS.writeFileSync(serverPath, MCP_SERVER_SOURCE, { encoding: "utf8", mode: 0o700 });
  const config = JSON.stringify({
    transport: "stdio",
    command: process.execPath,
    args: [serverPath],
  });
  const code = await once(
    spawn(
      binary.command,
      [...binary.prefixArgs, "mcp", "add-json", "rec", config, "--scope", "project"],
      { cwd: repo, stdio: "ignore" },
    ),
  );
  if (code !== 0) {
    throw new Error(`cmd mcp add-json exited ${code}`);
  }
  return serverPath;
};

// ── the recording PreToolUse hook ──────────────────────────────

/**
 * Installs the hook exactly the way `config.ts` does: a PreToolUse entry with
 * matcher ".*" and a 590s timeout in the project's settings.local.json.
 */
const installHook = (repo, hookPath) => {
  const dir = NodePath.join(repo, ".commandcode");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "settings.local.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: ".*",
              hooks: [{ type: "command", command: hookPath, timeout: 590 }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

// ── watchers ───────────────────────────────────────────────────

/**
 * Snapshots a growing file. Each poll that sees new bytes records the wall
 * clock, the byte length and how many complete lines exist — that is what
 * answers "does the transcript grow during the turn?".
 */
const makeGrowthWatcher = () => {
  const samples = [];
  let lastSize = -1;
  return {
    poll: (path) => {
      let stat;
      try {
        stat = NodeFS.statSync(path);
      } catch {
        return;
      }
      if (stat.size === lastSize) return;
      lastSize = stat.size;
      let lines = 0;
      try {
        lines = NodeFS.readFileSync(path, "utf8").split("\n").filter(Boolean).length;
      } catch {
        lines = -1;
      }
      samples.push({ at: Date.now(), bytes: stat.size, lines });
    },
    samples,
  };
};

const snapshotDir = (dir) => {
  const out = {};
  const walk = (base, prefix) => {
    let entries;
    try {
      entries = NodeFS.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = NodePath.join(base, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        try {
          const stat = NodeFS.statSync(full);
          out[rel] = { bytes: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          /* raced a delete */
        }
      }
    }
  };
  walk(dir, "");
  return out;
};

// ── one turn ───────────────────────────────────────────────────

const recordTurn = async (context, turn, index) => {
  const { repo, home, hookLog, policyPath, scratch } = context;
  NodeFS.writeFileSync(policyPath, JSON.stringify(turn.hookPolicy ?? { default: "allow" }), "utf8");
  const hookLogBefore = NodeFS.existsSync(hookLog)
    ? NodeFS.readFileSync(hookLog, "utf8").length
    : 0;

  const connectorArgs = buildArgs({
    prompt: turn.prompt,
    ...(turn.sessionId === undefined ? {} : { sessionId: turn.sessionId }),
    ...(turn.forkSession === true ? { forkSession: true } : {}),
    ...(turn.noSession === true ? { noSession: true } : {}),
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(turn.effort === undefined ? {} : { effort: turn.effort }),
    ...(turn.permissionMode === undefined ? {} : { permissionMode: turn.permissionMode }),
    ...(turn.yolo === false ? {} : { yolo: true }),
    ...(turn.maxTurns === undefined ? {} : { maxTurns: turn.maxTurns }),
    ...(turn.addDir === undefined ? {} : { addDir: turn.addDir }),
    toolsEnable: turn.toolsEnable ?? TOOLS_ENABLED,
    ...(turn.extraArgs === undefined ? {} : { extraArgs: turn.extraArgs }),
  });
  const argv = [...context.binary.prefixArgs, ...connectorArgs];
  const env = envAllowlist(process.env, {
    POSEIDON_THREAD_ID: "01JQ0000000000000000000000",
    // The recording hook reads these; they must carry an POSEIDON_ prefix or
    // the connector's own env allowlist (mirrored above) strips them.
    POSEIDON_RECORD_HOOK_LOG: hookLog,
    POSEIDON_RECORD_HOOK_POLICY: policyPath,
    ...turn.extraEnv,
  });

  const plansDir = NodePath.join(home, ".commandcode", "plans");
  const plansBefore = snapshotDir(plansDir);
  const filesBefore = snapshotDir(repo);

  const started = Date.now();
  const child = spawn(context.binary.command, argv, {
    cwd: turn.cwd ?? repo,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const chunks = [];
  let stdout = "";
  let stderr = "";
  let sessionId = null;
  child.stdout.on("data", (chunk) => {
    chunks.push({ at: Date.now() - started, chars: chunk.length });
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    const match = /session:\s*([0-9a-f-]{36})/i.exec(stderr);
    if (match !== null && sessionId === null) sessionId = match[1];
  });

  const growth = makeGrowthWatcher();
  const checkpointGrowth = makeGrowthWatcher();
  // The connector's own slug guess, and the directory the CLI really used —
  // recorded side by side so a test can assert the algorithm, not a hope.
  const guessedDir = NodePath.join(home, ".commandcode", "projects", slugFor(repo));
  const projectsRoot = NodePath.join(home, ".commandcode", "projects");
  let interrupted = false;
  // The slug the connector computes is not the one the CLI uses, so the live
  // watcher finds the session's directory by looking for its id. Without this
  // the growth samples describe a path that never exists.
  let liveDir = null;
  const findSessionDir = (id) => {
    for (const entry of NodeFS.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = NodePath.join(projectsRoot, entry.name);
      if (
        NodeFS.existsSync(NodePath.join(candidate, `${id}.jsonl`)) ||
        NodeFS.existsSync(NodePath.join(candidate, `${id}.checkpoints.jsonl`))
      ) {
        return candidate;
      }
    }
    return null;
  };
  const poller = setInterval(() => {
    if (sessionId === null) return;
    if (liveDir === null) liveDir = findSessionDir(sessionId);
    if (liveDir === null) return;
    growth.poll(NodePath.join(liveDir, `${sessionId}.jsonl`));
    checkpointGrowth.poll(NodePath.join(liveDir, `${sessionId}.checkpoints.jsonl`));
  }, TRANSCRIPT_POLL_MS);

  if (turn.sigintAfterMs !== undefined) {
    setTimeout(() => {
      interrupted = true;
      try {
        process.kill(-child.pid, "SIGINT");
      } catch {
        try {
          process.kill(child.pid, "SIGINT");
        } catch {
          /* already gone */
        }
      }
    }, turn.sigintAfterMs).unref();
  }

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ code: -1, signal: null, error: String(error) }));
  });
  clearInterval(poller);
  const durationMs = Date.now() - started;

  if (sessionId === null) {
    const match = /"sessionId":"([0-9a-f-]{36})"/.exec(stdout);
    if (match !== null) sessionId = match[1];
  }

  const readIf = (path) => {
    try {
      return NodeFS.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };

  // Where the CLI *actually* put the session, found by looking for the id
  // rather than by trusting the slug. The connector's guess is recorded next
  // to it so the difference is part of the fixture.
  const realDir = sessionId === null ? null : (liveDir ?? findSessionDir(sessionId));
  if (sessionId !== null && realDir !== null) {
    growth.poll(NodePath.join(realDir, `${sessionId}.jsonl`));
    checkpointGrowth.poll(NodePath.join(realDir, `${sessionId}.checkpoints.jsonl`));
  }
  const transcriptPath =
    sessionId === null || realDir === null ? null : NodePath.join(realDir, `${sessionId}.jsonl`);
  const hookLogText = readIf(hookLog);
  const hooks =
    hookLogText === null
      ? []
      : hookLogText
          .slice(hookLogBefore)
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));

  const plansAfter = snapshotDir(plansDir);
  const changedPlans = Object.keys(plansAfter).filter(
    (name) =>
      plansBefore[name] === undefined || plansBefore[name].mtimeMs !== plansAfter[name].mtimeMs,
  );
  const filesAfter = snapshotDir(repo);
  const touched = Object.keys(filesAfter).filter(
    (name) =>
      !name.startsWith(".git/") &&
      (filesBefore[name] === undefined || filesBefore[name].mtimeMs !== filesAfter[name].mtimeMs),
  );

  // Every session an earlier turn ran in, as it stands now. A turn that forks
  // or resumes one says here whether it wrote to it: the fork recording's
  // whole claim is that the session it forked from is left as it was.
  const earlierSessions = [];
  for (const earlier of context.earlier ?? []) {
    if (earlier.sessionId === null || earlier.sessionId === sessionId) continue;
    if (earlierSessions.some((entry) => entry.sessionId === earlier.sessionId)) continue;
    const text = earlier.transcriptPath === null ? null : readIf(earlier.transcriptPath);
    earlierSessions.push({
      sessionId: earlier.sessionId,
      transcriptBytes: text === null ? null : text.length,
    });
  }

  return {
    index,
    argv,
    connectorArgs,
    earlierSessions,
    cwd: turn.cwd ?? repo,
    prompt: turn.prompt,
    envKeys: Object.keys(env).sort(),
    sessionId,
    exitCode: exit.code,
    signal: exit.signal,
    interrupted,
    durationMs,
    stdout,
    stderr,
    chunks,
    transcriptPath,
    // What the connector would have tailed, vs. what the CLI really wrote.
    guessedTranscriptPath:
      sessionId === null ? null : NodePath.join(guessedDir, `${sessionId}.jsonl`),
    transcriptDirMatchesConnectorSlug: realDir === guessedDir,
    projectDirListing: realDir === null ? [] : NodeFS.readdirSync(realDir).sort(),
    transcript: transcriptPath === null ? null : readIf(transcriptPath),
    transcriptGrowth: growth.samples.map((s) => ({ ...s, at: s.at - started })),
    checkpointGrowth: checkpointGrowth.samples.map((s) => ({ ...s, at: s.at - started })),
    checkpoints:
      sessionId === null || realDir === null
        ? null
        : readIf(NodePath.join(realDir, `${sessionId}.checkpoints.jsonl`)),
    transcriptMeta:
      sessionId === null || realDir === null
        ? null
        : readIf(NodePath.join(realDir, `${sessionId}.meta.json`)),
    hooks,
    plans: changedPlans.map((name) => ({
      name,
      content: readIf(NodePath.join(plansDir, name)),
    })),
    touchedFiles: touched.map((name) => ({ name, content: readIf(NodePath.join(repo, name)) })),
    scratch,
  };
};

// ── scrubbing ──────────────────────────────────────────────────

/**
 * Real recordings carry the operator's home directory, the scratch path and
 * their account name. Nothing token-shaped has ever appeared in one, but the
 * scrubber assumes it will.
 */
const makeScrubber = (context) => {
  const home = context.home;
  // Both names that identify the operator: the home directory's own basename
  // and the Command Code account `status --json` reports.
  const names = [NodePath.basename(home), context.account].filter(
    (name) => typeof name === "string" && name.length > 2,
  );
  const replacements = [
    [context.scratch, "<SCRATCH>"],
    [home, "<HOME>"],
  ];
  return (value) => {
    if (typeof value === "string") {
      let out = value;
      for (const [from, to] of replacements) {
        out = out.split(from).join(to);
        out = out.split(JSON.stringify(from).slice(1, -1)).join(to);
      }
      for (const name of names) {
        out = out.replaceAll(new RegExp(`\\b${name}\\b`, "g"), "user");
      }
      out = out.replaceAll(/\b(sk|pk|ghp|gho|Bearer)[-_ ][A-Za-z0-9._-]{12,}/g, "<REDACTED>");
      return out;
    }
    if (Array.isArray(value)) return value.map((entry) => makeScrubber(context)(entry));
    if (value !== null && typeof value === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(value)) out[key] = makeScrubber(context)(entry);
      return out;
    }
    return value;
  };
};

// ── writing a recording ────────────────────────────────────────

const writeRecording = (name, scenario, turns, context) => {
  const dir = NodePath.join(FIXTURE_ROOT, name);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const scrub = makeScrubber(context);

  // The model the frames say actually answered — not the flag we passed, which
  // is absent when the run used the account default.
  const observedModel = turns
    .flatMap((turn) => turn.stdout.split("\n"))
    .flatMap((line) => {
      try {
        const frame = JSON.parse(line);
        return frame?.event?.type === "model_request_start" ? [frame.event.model] : [];
      } catch {
        return [];
      }
    })[0];

  const manifest = {
    scenario: name,
    description: scenario.description,
    cli: context.binary.display,
    cliVersion: context.cliVersion,
    recordedOn: new Date().toISOString().slice(0, 10),
    model: observedModel ?? context.model ?? "the CLI's configured default",
    modelRequested: context.model ?? null,
    real: true,
    turns: [],
  };

  turns.forEach((turn, index) => {
    const prefix = turns.length === 1 ? "" : `turn${index + 1}.`;
    NodeFS.writeFileSync(NodePath.join(dir, `${prefix}stdout.ndjson`), scrub(turn.stdout), "utf8");
    NodeFS.writeFileSync(NodePath.join(dir, `${prefix}stderr.txt`), scrub(turn.stderr), "utf8");
    if (turn.transcript !== null) {
      NodeFS.writeFileSync(
        NodePath.join(dir, `${prefix}transcript.jsonl`),
        scrub(turn.transcript),
        "utf8",
      );
    }
    if (turn.checkpoints !== null) {
      NodeFS.writeFileSync(
        NodePath.join(dir, `${prefix}checkpoints.jsonl`),
        scrub(turn.checkpoints),
        "utf8",
      );
    }
    if (turn.hooks.length > 0) {
      NodeFS.writeFileSync(
        NodePath.join(dir, `${prefix}hooks.json`),
        `${JSON.stringify(scrub(turn.hooks), null, 2)}\n`,
        "utf8",
      );
    }
    manifest.turns.push(
      scrub({
        index,
        prompt: turn.prompt,
        connectorArgs: turn.connectorArgs,
        argv: turn.argv,
        envKeys: turn.envKeys,
        sessionId: turn.sessionId,
        exitCode: turn.exitCode,
        signal: turn.signal,
        interrupted: turn.interrupted,
        durationMs: turn.durationMs,
        stdoutChunks: turn.chunks,
        transcriptPath: turn.transcriptPath,
        guessedTranscriptPath: turn.guessedTranscriptPath,
        transcriptDirMatchesConnectorSlug: turn.transcriptDirMatchesConnectorSlug,
        projectDirListing: turn.projectDirListing,
        transcriptGrowth: turn.transcriptGrowth,
        transcriptBytes: turn.transcript === null ? null : turn.transcript.length,
        checkpointGrowth: turn.checkpointGrowth,
        transcriptMeta: turn.transcriptMeta,
        hookCount: turn.hooks.length,
        plans: turn.plans,
        touchedFiles: turn.touchedFiles,
        ...(turn.earlierSessions.length === 0 ? {} : { earlierSessions: turn.earlierSessions }),
        files: {
          stdout: `${prefix}stdout.ndjson`,
          stderr: `${prefix}stderr.txt`,
          ...(turn.transcript === null ? {} : { transcript: `${prefix}transcript.jsonl` }),
          ...(turn.checkpoints === null ? {} : { checkpoints: `${prefix}checkpoints.jsonl` }),
          ...(turn.hooks.length === 0 ? {} : { hooks: `${prefix}hooks.json` }),
        },
      }),
    );
  });

  NodeFS.writeFileSync(
    NodePath.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return dir;
};

// ── main ───────────────────────────────────────────────────────

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.includes("--list") || argv.length === 0) {
    process.stdout.write(`${scenarioNames().join("\n")}\n`);
    return;
  }
  const name = argv[0];
  const scenario = SCENARIOS[name];
  if (scenario === undefined) {
    throw new Error(`unknown scenario ${name}; --list to see them`);
  }
  const modelFlag = argv.indexOf("--model");
  const model = modelFlag === -1 ? scenario.model : argv[modelFlag + 1];
  if (model !== undefined && !AUTHORISED_MODELS.includes(model)) {
    throw new Error(
      `${model} is not one of the models authorised for recording: ${AUTHORISED_MODELS.join(", ")}`,
    );
  }

  const home = NodeOS.homedir();
  const scratchBase = process.env.RECORD_SCRATCH ?? NodePath.join(NodeOS.tmpdir(), "poseidon-rec");
  const scratch = NodeFS.realpathSync(
    (() => {
      const dir = NodePath.join(scratchBase, `${name}-${NodeCrypto.randomUUID().slice(0, 8)}`);
      NodeFS.mkdirSync(dir, { recursive: true });
      return dir;
    })(),
  );

  const repo = await makeWorkspace(scratch, scenario.seed);
  writeScratchSeed(scratch, scenario.scratchSeed);
  const hookPath = NodePath.join(scratch, "record-hook.mjs");
  NodeFS.writeFileSync(hookPath, HOOK_SOURCE, { encoding: "utf8", mode: 0o700 });
  const hookLog = NodePath.join(scratch, "hooks.ndjson");
  const policyPath = NodePath.join(scratch, "hook-policy.json");
  installHook(repo, hookPath);

  const binary = resolveBinary();
  const cliVersion = await binaryVersion(binary);
  process.stderr.write(`binary: ${binary.display} (${cliVersion})\n`);
  if (scenario.mcpServer === true) {
    await installMcpServer(binary, repo, scratch);
  }
  const account = await binaryAccount(binary);
  const context = { repo, home, hookLog, policyPath, scratch, model, binary, cliVersion, account };
  const recorded = [];
  let previousSessionId;
  for (const [index, turn] of scenario.turns.entries()) {
    const resolved =
      typeof turn === "function" ? turn({ sessionId: previousSessionId, scratch, repo }) : turn;
    process.stderr.write(`▸ ${name} turn ${index + 1}: ${resolved.prompt.slice(0, 60)}\n`);
    const result = await recordTurn({ ...context, earlier: recorded }, resolved, index);
    process.stderr.write(
      `  exit=${result.exitCode} signal=${result.signal} session=${result.sessionId} hooks=${result.hooks.length} ${result.durationMs}ms\n`,
    );
    recorded.push(result);
    previousSessionId = result.sessionId ?? previousSessionId;
  }

  const dir = writeRecording(name, scenario, recorded, context);
  process.stderr.write(`✓ wrote ${NodePath.relative(ROOT, dir)}\n`);
  if (process.env.RECORD_KEEP_SCRATCH !== "1") {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  } else {
    process.stderr.write(`  scratch kept at ${scratch}\n`);
  }
};

await main();
