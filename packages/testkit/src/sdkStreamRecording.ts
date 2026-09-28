/**
 * Recording a harness an SDK drives over stdio NDJSON — the `sdk-stream`
 * transport — at the process boundary.
 *
 * The SDK spawns the CLI and the two talk in NDJSON lines: the harness's
 * messages and `control_request`s on its stdout, the SDK's user messages,
 * `control_request`s and `control_response`s on its stdin. Recording there
 * rather than inside the SDK means the capture is exactly what the real CLI said
 * and was told, and a replay can put it back under the real SDK and the real
 * connector code.
 *
 * Two halves:
 *
 * - `makeTeeLauncher` writes an executable a recording points the connector's
 *   binary path at. It runs `bin/stdio-tee.mjs`, which spawns the real binary
 *   and appends every line in either direction to `invocation-<n>.ndjson` in the
 *   raw directory, one `RecordedFrame` each.
 * - `finalizeSdkStreamRecording` turns a raw directory into
 *   `fixtures/<kind>/<scenario>/`: a manifest and the scrubbed invocation files.
 *
 * `loadSdkStreamRecording` reads one back for a test to assert against. The
 * replay half is `replaySdkStream.ts`.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  fixturesRoot,
  readManifest,
  type RecordedFrame,
  type RecordingManifest,
} from "./recording";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

/** The tee a launcher runs. */
const TEE_SCRIPT = NodePath.join(HERE, "..", "bin", "stdio-tee.mjs");

/** Quotes one word for `/bin/sh`. */
const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Writes an executable `#!/bin/sh` launcher that runs `node <script> <config>`
 * with whatever argv it was given. Node is named by absolute path, so the
 * launcher works under a connector's default-deny environment with no PATH.
 */
export const writeNodeLauncher = (file: string, script: string, configFile: string): string => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(
    file,
    `#!/bin/sh\nexec ${[process.execPath, script, configFile].map(shellQuote).join(" ")} "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  return file;
};

export interface TeeLauncherOptions {
  /** The real CLI, by absolute path. */
  readonly realBinary: string;
  /** Where the raw invocation files land, and where the launcher is written. */
  readonly rawDir: string;
}

/**
 * Writes the tee's `config.json` and a launcher beside it into `rawDir`, and
 * returns the launcher's path. Point the connector's binary path at it: every
 * launch — a probe's `--version` as much as a session — becomes one numbered
 * invocation in `rawDir`.
 */
export const makeTeeLauncher = (options: TeeLauncherOptions): string => {
  const rawDir = NodePath.resolve(options.rawDir);
  NodeFS.mkdirSync(rawDir, { recursive: true });
  const configFile = NodePath.join(rawDir, "config.json");
  NodeFS.writeFileSync(
    configFile,
    `${JSON.stringify({ realBinary: NodePath.resolve(options.realBinary), rawDir }, null, 2)}\n`,
    "utf8",
  );
  return writeNodeLauncher(NodePath.join(rawDir, "launcher"), TEE_SCRIPT, configFile);
};

// ── the manifest ───────────────────────────────────────────────

/** One launch of the harness, as the manifest lists it. */
export interface SdkStreamInvocation {
  /** The argv the SDK or connector passed, scrubbed. */
  readonly argv: ReadonlyArray<string>;
  /** The working directory it ran in, scrubbed. */
  readonly cwd: string;
  /** The frames file beside the manifest. */
  readonly file: string;
  /** Null when the harness was killed by a signal. */
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** The fields an `sdk-stream` manifest adds to the common ones. */
export interface SdkStreamManifestExtra {
  readonly sdkVersion: string;
  readonly prompts: ReadonlyArray<string>;
  readonly invocations: ReadonlyArray<SdkStreamInvocation>;
}

/** What the tee wrote for one invocation before finalising. */
interface RawInvocation {
  readonly n: number;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly frames: ReadonlyArray<RecordedFrame>;
}

const parseFrames = (text: string): ReadonlyArray<RecordedFrame> =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedFrame);

const readRawInvocations = (rawDir: string): ReadonlyArray<RawInvocation> =>
  NodeFS.readdirSync(rawDir)
    .flatMap((name) => {
      const match = /^invocation-(\d+)\.json$/.exec(name);
      return match === null ? [] : [Number(match[1])];
    })
    .sort((a, b) => a - b)
    .map((n) => {
      const meta = JSON.parse(
        NodeFS.readFileSync(NodePath.join(rawDir, `invocation-${n}.json`), "utf8"),
      ) as Omit<RawInvocation, "n" | "frames">;
      const framesFile = NodePath.join(rawDir, `invocation-${n}.ndjson`);
      const frames = NodeFS.existsSync(framesFile)
        ? parseFrames(NodeFS.readFileSync(framesFile, "utf8"))
        : [];
      return { ...meta, n, frames };
    });

// ── scrubbing ──────────────────────────────────────────────────

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keys whose string value names the account, wherever they appear. */
const IDENTITY_KEY =
  /^(e-?mail(_?address)?|user_?email|(org|organi[sz]ation)(_?(name|id|uuid))?|(account|user)_?(name|id|uuid))$/i;
/** Objects whose identifying members name the account… */
const ACCOUNT_SCOPE = /^(account|org|organi[sz]ation|user)$/i;
/** …and those members. */
const SCOPED_IDENTITY_KEY = /^(name|display_?name|uuid|id|email)$/i;
/** Keys whose string value is a credential, whatever it looks like. */
const SECRET_KEY =
  /^(authorization|proxy-authorization|x-api-key|api_?key|(access|refresh|id|auth|bearer)?_?token|password|secret)$/i;
/** Token-shaped strings, and the MCP bearer inside `--mcp-config`'s JSON. */
const TOKEN_SHAPED = /\b(sk|pk|ghp|gho|Bearer)[-_ ][A-Za-z0-9._~+/=-]{12,}/g;

/**
 * Every string in the capture that names the account — the email, the
 * organisation's name and id, the account uuid — from the init and account
 * payloads and `auth status`, mapped to what replaces it everywhere. Session
 * ids are uuids too and stay: only a uuid under an identity key is scrubbed.
 */
const accountValues = (values: ReadonlyArray<unknown>): Map<string, string> => {
  const found = new Map<string, string>();
  const note = (value: string): void => {
    if (value.length < 3) return;
    found.set(
      value,
      /^[^@\s]+@[^@\s]+$/.test(value)
        ? "user@example.com"
        : UUID.test(value)
          ? "00000000-0000-0000-0000-000000000000"
          : "<ACCOUNT>",
    );
  };
  const walk = (value: unknown, scoped: boolean): void => {
    if (typeof value === "string") {
      for (const email of value.match(EMAIL) ?? []) note(email);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, scoped);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (
          typeof entry === "string" &&
          (IDENTITY_KEY.test(key) || (scoped && SCOPED_IDENTITY_KEY.test(key)))
        ) {
          note(entry);
        }
        walk(entry, ACCOUNT_SCOPE.test(key));
      }
    }
  };
  for (const value of values) walk(value, false);
  return found;
};

/** A path as it may be spelled: as given, resolved, and without macOS's `/private`. */
const spellings = (path: string): ReadonlyArray<string> => {
  const out = new Set([path]);
  try {
    out.add(NodeFS.realpathSync(path));
  } catch {
    // A directory that is gone is still spelled the way it was.
  }
  for (const spelling of Array.from(out)) {
    if (spelling.startsWith("/private/")) out.add(spelling.slice("/private".length));
  }
  return [...out];
};

/**
 * A path where it stands as a whole path or a prefix of one: not inside a
 * longer name, so a temp directory spelled `/tmp` leaves `/var/tmp` and
 * `/tmpfile` alone.
 */
const wholePath = (path: string): RegExp =>
  new RegExp(`(?<![\\w.-])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");

/**
 * The operator's own skills, commands and agents, by name, each mapped to a
 * neutral stand-in (`user-skill-1`, …).
 *
 * A harness that loads the user's configuration lists these in its handshake
 * — names, and descriptions the user wrote — and they are the operator's
 * business, not the recording's. They are read from the harness's config
 * directory: every entry of `skills/`, `commands/` and `agents/`, a file's
 * extension dropped.
 */
const operatorEntries = (configDir: string): Map<string, string> => {
  const names = new Set<string>();
  for (const sub of ["skills", "commands", "agents"]) {
    let entries: ReadonlyArray<string> = [];
    try {
      entries = NodeFS.readdirSync(NodePath.join(configDir, sub));
    } catch {
      // A config directory without this kind of entry.
    }
    for (const entry of entries) {
      const name = entry.replace(/\.[^.]+$/, "");
      if (name.length > 0 && !name.startsWith(".")) names.add(name);
    }
  }
  return new Map([...names].sort().map((name, index) => [name, `user-skill-${index + 1}`]));
};

/**
 * The handshake keys whose lists are drawn from the operator's installation —
 * their own skills and commands, and the plugins they installed — rather than
 * from the harness alone. A stand-in per name is not enough: a plugin's entry
 * is named by whoever wrote it, so the whole list is replaced.
 */
const OPERATOR_LIST_KEY = /^(skills|slash_commands|commands)$/;

/** What an operator-sourced list becomes: one neutral entry of the same shape. */
export const SCRUBBED_ENTRY = "scrubbed-entry";

const scrubbedList = (list: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
  const first = list[0];
  if (first === undefined) return [];
  if (first === null || typeof first !== "object") return [SCRUBBED_ENTRY];
  return [
    {
      name: SCRUBBED_ENTRY,
      description: `${SCRUBBED_ENTRY} (recording)`,
      ...("argumentHint" in first ? { argumentHint: "" } : {}),
    },
  ];
};

interface ScrubContext {
  readonly home: string;
  /** The scratch root the throwaway repos live under; null when there is none. */
  readonly scratch: string | null;
  /** The system temp directory, where the harness's own throwaway files go. */
  readonly tmp: string;
  readonly username: string;
  readonly account: ReadonlyMap<string, string>;
  /** The operator's own skills, commands and agents: name → stand-in. */
  readonly entries: ReadonlyMap<string, string>;
}

/**
 * The cmd scrubbing rules, plus the account, the MCP bearer and the operator's
 * own entries: account values are replaced first, then the scratch root
 * becomes `<SCRATCH>`, the system temp directory `<TMP>` and the home
 * directory `<HOME>` (longest spelling first, so a scratch root under temp or
 * home stays a scratch root), the username becomes
 * `user`, and credentials become `<REDACTED>` — under a credential's key
 * whatever their shape, anywhere when they are token-shaped. The handshake's
 * `skills`, `slash_commands` and `commands` lists become one scrubbed entry
 * each. Elsewhere an operator entry is replaced where it is listed: a list
 * item that is its name, and an object whose `name` it is, whose `description`
 * goes with it.
 */
const makeScrubber = (context: ScrubContext): ((value: unknown) => unknown) => {
  const paths = [
    ...(context.scratch === null ? [] : spellings(context.scratch).map((p) => [p, "<SCRATCH>"])),
    ...spellings(context.tmp).map((p) => [p, "<TMP>"]),
    ...spellings(context.home).map((p) => [p, "<HOME>"]),
  ]
    .sort((a, b) => b[0]!.length - a[0]!.length)
    .map(([from, to]) => [wholePath(from!), to!] as const);
  const account = [...context.account].sort((a, b) => b[0].length - a[0].length);
  const username = context.username.length > 2 ? context.username : null;

  const text = (value: string): string => {
    let out = value;
    for (const [from, to] of account) out = out.split(from).join(to);
    out = out.replaceAll(EMAIL, "user@example.com");
    for (const [from, to] of paths) out = out.replaceAll(from, to);
    if (username !== null) {
      out = out.replaceAll(new RegExp(`\\b${username}\\b`, "g"), "user");
    }
    return out.replaceAll(TOKEN_SHAPED, "<REDACTED>");
  };
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) {
      return value.map((entry) =>
        typeof entry === "string" && context.entries.has(entry)
          ? context.entries.get(entry)
          : scrub(entry),
      );
    }
    if (value !== null && typeof value === "object") {
      const named = (value as { readonly name?: unknown }).name;
      if (typeof named === "string" && context.entries.has(named)) {
        const stand = context.entries.get(named)!;
        return scrub({
          ...value,
          name: stand,
          ...("description" in value ? { description: `${stand} (user)` } : {}),
        });
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          text(key),
          typeof entry === "string" && SECRET_KEY.test(key)
            ? "<REDACTED>"
            : Array.isArray(entry) && OPERATOR_LIST_KEY.test(key)
              ? scrubbedList(entry)
              : scrub(entry),
        ]),
      );
    }
    return value;
  };
  return scrub;
};

// ── finalising ─────────────────────────────────────────────────

export interface FinalizeOptions {
  readonly kind: string;
  readonly scenario: string;
  readonly rawDir: string;
  readonly description: string;
  readonly cliVersion: string;
  readonly sdkVersion: string;
  /** The model the harness's own frames name. */
  readonly model: string;
  readonly prompts: ReadonlyArray<string>;
  /** Defaults to `packages/testkit/fixtures`; tests write elsewhere. */
  readonly fixturesRoot?: string;
  /** Defaults to the operator's own. */
  readonly home?: string;
  readonly username?: string;
  /**
   * The harness's config directory, whose `skills/`, `commands/` and `agents/`
   * name the operator's own entries; defaults to `<home>/.claude`.
   */
  readonly configDir?: string;
  /**
   * The scratch root; defaults to the parent of the first stream run's working
   * directory, the same directory a replay restores `<SCRATCH>` from.
   */
  readonly scratch?: string;
  readonly recordedOn?: string;
}

/** The parent of a scratch repo, unless that would swallow the home directory. */
const scratchOf = (cwd: string | undefined, home: string): string | null => {
  if (cwd === undefined) return null;
  const parent = NodePath.dirname(cwd);
  const within = (dir: string, inner: string): boolean =>
    inner === dir || inner.startsWith(`${dir}${NodePath.sep}`);
  return parent === NodePath.parse(parent).root || within(parent, home) ? null : parent;
};

/**
 * Writes `fixtures/<kind>/<scenario>/` from a raw directory the tee filled:
 * `manifest.json`, and one scrubbed `invocation-<n>.ndjson` per launch. The
 * scenario directory is replaced whole. Returns its path.
 */
export const finalizeSdkStreamRecording = (options: FinalizeOptions): string => {
  const invocations = readRawInvocations(options.rawDir);
  const home = options.home ?? NodeOS.homedir();
  const firstStream = invocations.find((invocation) =>
    invocation.argv.some((word) => word === "stream-json"),
  );
  const scrub = makeScrubber({
    home,
    scratch: options.scratch ?? scratchOf(firstStream?.cwd, home),
    tmp: NodeOS.tmpdir(),
    username: options.username ?? NodeOS.userInfo().username,
    account: accountValues(invocations.flatMap((invocation) => invocation.frames)),
    entries: operatorEntries(options.configDir ?? NodePath.join(home, ".claude")),
  });

  const dir = NodePath.join(fixturesRoot(options.kind, options.fixturesRoot), options.scenario);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });

  const listed = invocations.map((invocation, index): SdkStreamInvocation => {
    const file = `invocation-${index + 1}.ndjson`;
    NodeFS.writeFileSync(
      NodePath.join(dir, file),
      invocation.frames.map((frame) => `${JSON.stringify(scrub(frame))}\n`).join(""),
      "utf8",
    );
    return {
      argv: scrub(invocation.argv) as ReadonlyArray<string>,
      cwd: scrub(invocation.cwd) as string,
      file,
      exitCode: invocation.exitCode,
      signal: invocation.signal,
    };
  });

  const manifest: RecordingManifest & SdkStreamManifestExtra = {
    formatVersion: 1,
    kind: options.kind,
    transport: "sdk-stream",
    scenario: options.scenario,
    description: options.description,
    cliVersion: options.cliVersion,
    sdkVersion: options.sdkVersion,
    recordedOn: options.recordedOn ?? new Date().toISOString().slice(0, 10),
    model: options.model,
    real: true,
    prompts: scrub(options.prompts) as ReadonlyArray<string>,
    invocations: listed,
  };
  NodeFS.writeFileSync(
    NodePath.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return dir;
};

// ── reading one back ───────────────────────────────────────────

export interface SdkStreamRecording {
  readonly manifest: RecordingManifest & SdkStreamManifestExtra;
  /** Each invocation with its frames, in launch order. */
  readonly invocations: ReadonlyArray<
    SdkStreamInvocation & { readonly frames: ReadonlyArray<RecordedFrame> }
  >;
}

/**
 * Reads one `sdk-stream` recording. Throws rather than degrading: a manifest
 * that is not real, not this transport, or lists a file that does not parse is
 * a recording nobody should be testing against.
 */
export const loadSdkStreamRecording = (
  kind: string,
  scenario: string,
  root?: string,
): SdkStreamRecording => {
  const manifest = readManifest<SdkStreamManifestExtra>(kind, scenario, root);
  if (manifest.transport !== "sdk-stream") {
    throw new Error(`${kind}/${scenario}: recorded over ${manifest.transport}, not sdk-stream`);
  }
  const dir = NodePath.join(fixturesRoot(kind, root), scenario);
  return {
    manifest,
    invocations: manifest.invocations.map((invocation) => ({
      ...invocation,
      frames: parseFrames(NodeFS.readFileSync(NodePath.join(dir, invocation.file), "utf8")),
    })),
  };
};
