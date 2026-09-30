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
 *
 * Nothing in the tee or the finaliser knows the envelope: every NDJSON line is
 * one frame whichever way it went. So a harness that speaks JSON-RPC over stdio
 * (`stdio-jsonrpc`) is recorded by the same two halves, through
 * `finalizeStdioRecording` and `loadStdioRecording` with its own transport and
 * its own idea of which launches are runs (`stdioJsonRpcRecording.ts`).
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
  type RecordingTransport,
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

/** The transports whose captures are the tee's NDJSON lines. */
export type StdioTransport = Extract<RecordingTransport, "sdk-stream" | "stdio-jsonrpc">;

/** One launch of the harness, as the manifest lists it. */
export interface StdioInvocation {
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

/** The fields a tee-recorded manifest adds to the common ones. */
export interface StdioManifestExtra {
  /** The SDK that drove the harness, when one did. */
  readonly sdkVersion?: string;
  readonly prompts: ReadonlyArray<string>;
  readonly invocations: ReadonlyArray<StdioInvocation>;
}

/** The fields an `sdk-stream` manifest adds to the common ones. */
export interface SdkStreamManifestExtra extends StdioManifestExtra {
  readonly sdkVersion: string;
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

/**
 * Keys whose string value names the account, wherever they appear — among
 * them the ChatGPT account id an app-server's `account/read` routes by — and
 * the installation's own id, which names the machine as surely.
 */
const IDENTITY_KEY =
  /^(e-?mail(_?address)?|user_?email|(org|organi[sz]ation)(_?(name|id|uuid))?|(chatgpt_?)?(account|user)_?(name|id|uuid)|installation_?id)$/i;
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
 * A `"key": "value"` pair inside text: a line of a pretty-printed JSON
 * document, which the tee captures as one string per line (`auth status
 * --json`).
 */
const TEXT_PAIR = /"([A-Za-z_]+)"\s*:\s*"([^"\\]*)"/g;
/** A uuid joined to another by `_`, as the CLI names a directory per org and account. */
const JOINED_UUID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/**
 * Every string in the capture that names the account — the email, the
 * organisation's name and id, the account uuid — from the init and account
 * payloads and `auth status`, mapped to what replaces it everywhere. Session
 * ids are uuids too and stay: only a uuid under an identity key is scrubbed,
 * and one joined by `_` to such a uuid, which is how the CLI names the
 * directory of an org's synced skills and plugins (`<org id>_<account id>`).
 */
const accountValues = (values: ReadonlyArray<unknown>): Map<string, string> => {
  const found = new Map<string, string>();
  const texts: Array<string> = [];
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
      texts.push(value);
      for (const email of value.match(EMAIL) ?? []) note(email);
      for (const [, key, entry] of value.matchAll(TEXT_PAIR)) {
        if (IDENTITY_KEY.test(key!)) note(entry!);
      }
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
  for (const text of texts) {
    for (const [, first, second] of text.matchAll(JOINED_UUID)) {
      if (found.has(first!)) note(second!);
      if (found.has(second!)) note(first!);
    }
  }
  return found;
};

/**
 * The MCP servers and plugins the capture shows the operator's own
 * installation brought: a server whose `source` is anything but `dynamic`
 * (what the SDK passed — Poseidon's own), and a plugin whose `source` is
 * neither `@inline` (a `--plugin-dir`, Poseidon's) nor `@builtin` (the
 * harness's). Their names say what the operator connected — an account's
 * connectors, a marketplace's plugins — so they go the way of the operator's
 * own entries.
 */
const capturedOperatorNames = (
  values: ReadonlyArray<unknown>,
): { readonly servers: ReadonlyArray<string>; readonly plugins: ReadonlyArray<string> } => {
  const servers = new Set<string>();
  const plugins = new Set<string>();
  const sourced = (names: Set<string>, list: unknown, own: (source: string) => boolean): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const { name, source } = (entry ?? {}) as { name?: unknown; source?: unknown };
      if (typeof name === "string" && typeof source === "string" && !own(source)) names.add(name);
    }
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "mcp_servers") sourced(servers, entry, (source) => source === "dynamic");
      if (key === "plugins") {
        sourced(
          plugins,
          entry,
          (source) => source.endsWith("@inline") || source.endsWith("@builtin"),
        );
      }
      walk(entry);
    }
  };
  for (const value of values) walk(value);
  return { servers: [...servers], plugins: [...plugins] };
};

/** The prefix an MCP server's tools carry: `mcp__<name, other than [A-Za-z0-9_-] as _>__`. */
const mcpToolPrefix = (server: string): string =>
  `mcp__${server.replaceAll(/[^A-Za-z0-9_-]/g, "_")}__`;

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
 * Names the caller knows are the operator's own — MCP servers from their
 * configuration, skills from a directory `operatorEntries` does not read —
 * added to the entries, the stand-ins numbered over the whole set.
 */
const withOperatorNames = (
  entries: ReadonlyMap<string, string>,
  names: ReadonlyArray<string>,
): Map<string, string> =>
  new Map(
    [...new Set([...entries.keys(), ...names.filter((name) => name.length > 0)])]
      .sort()
      .map((name, index) => [name, `user-skill-${index + 1}`]),
  );

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `word` standing alone: not inside a longer name or path segment. */
const standalone = (word: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(word)}(?![A-Za-z0-9_-])`, "g");

/**
 * The handshake keys whose lists are drawn from the operator's installation —
 * their own skills and commands, and the plugins they installed — rather than
 * from the harness alone. A stand-in per name is not enough: a plugin's entry
 * is named by whoever wrote it, so the whole list is replaced.
 */
const OPERATOR_LIST_KEY = /^(skills|slash_commands|commands)$/;

/** What an operator-sourced entry becomes: one neutral entry of the same shape. */
export const SCRUBBED_ENTRY = "scrubbed-entry";

/**
 * The neutral stand-in for a list's operator entries, shaped like `first`:
 * its name and description neutral, an `argumentHint` empty, any other text
 * `scrubbed-entry`, flags and numbers kept, and anything nested left out —
 * so a reader that decodes the list's members still finds each one.
 */
const scrubbedEntry = (first: unknown): unknown => {
  if (first === null || typeof first !== "object") return SCRUBBED_ENTRY;
  return Object.fromEntries(
    Object.entries({ name: SCRUBBED_ENTRY, description: "", ...first }).flatMap(([key, value]) => {
      if (key === "description") return [[key, `${SCRUBBED_ENTRY} (recording)`]];
      if (key === "argumentHint") return [[key, ""]];
      if (typeof value === "string") return [[key, SCRUBBED_ENTRY]];
      return value === null || typeof value === "boolean" || typeof value === "number"
        ? [[key, value]]
        : [];
    }),
  );
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
  /** Of those, the ones the caller named, replaced wherever they stand alone. */
  readonly operatorNames: ReadonlyArray<string>;
  /** Of those, the MCP servers the capture showed the operator's installation bring. */
  readonly operatorServers: ReadonlyArray<string>;
  /** The machine's name. */
  readonly hostname: string;
}

/**
 * The cmd scrubbing rules, plus the account, the MCP bearer and the operator's
 * own entries: account values are replaced first, then the scratch root
 * becomes `<SCRATCH>`, the system temp directory `<TMP>` and the home
 * directory `<HOME>` (longest spelling first, so a scratch root under temp or
 * home stays a scratch root), the username becomes
 * `user`, and credentials become `<REDACTED>` — under a credential's key
 * whatever their shape, anywhere when they are token-shaped. A `skills`,
 * `slash_commands` or `commands` list keeps only the scenario's own entries,
 * those under the scratch root, and one scrubbed entry for the rest. Elsewhere an operator entry is replaced where it is listed: a list
 * item that is its name, and an object whose `name` it is, whose `description`
 * and `name@…` `source` go with it. An operator MCP server's tools become one
 * `mcp__<stand-in>__scrubbed-entry` per list. A name the caller gave is
 * replaced in text and keys too, wherever it stands alone, and the machine's
 * name becomes `<HOST>`.
 */
const makeScrubber = (context: ScrubContext): ((value: unknown) => unknown) => {
  const paths = [
    ...(context.scratch === null ? [] : spellings(context.scratch).map((p) => [p, "<SCRATCH>"])),
    ...spellings(context.tmp).map((p) => [p, "<TMP>"]),
    ...spellings(context.home).map((p) => [p, "<HOME>"]),
  ]
    .filter(([from]) => from!.length > 1)
    .sort((a, b) => b[0]!.length - a[0]!.length)
    .map(([from, to]) => [wholePath(from!), to!] as const);
  const account = [...context.account].sort((a, b) => b[0].length - a[0].length);
  const username = context.username.length > 2 ? context.username : null;
  const hosts = [context.hostname, context.hostname.replace(/\.local$/, "")]
    .filter((host) => host.length > 3)
    .map(standalone);
  const named = [...context.operatorNames]
    .sort((a, b) => b.length - a.length)
    .map((name) => [standalone(name), context.entries.get(name)!] as const);
  const serverTools = context.operatorServers.map(
    (server) => [mcpToolPrefix(server), context.entries.get(server)!] as const,
  );
  /** An operator server's tool, as one stand-in per server. */
  const serverTool = (entry: string): string | undefined => {
    const server = serverTools.find(([prefix]) => entry.startsWith(prefix));
    return server === undefined ? undefined : `${mcpToolPrefix(server[1])}${SCRUBBED_ENTRY}`;
  };

  const text = (value: string): string => {
    let out = value;
    for (const [from, to] of account) out = out.split(from).join(to);
    out = out.replaceAll(EMAIL, "user@example.com");
    for (const [from, to] of paths) out = out.replaceAll(from, to);
    for (const host of hosts) out = out.replaceAll(host, "<HOST>");
    for (const [name, stand] of named) out = out.replaceAll(name, stand);
    if (username !== null) {
      out = out.replaceAll(new RegExp(`\\b${username}\\b`, "g"), "user");
    }
    return out.replaceAll(TOKEN_SHAPED, "<REDACTED>");
  };
  /** The scenario's own: an entry whose `path` lies under the scratch root. */
  const scenarios = (entry: unknown): boolean => {
    const path = (entry as { readonly path?: unknown } | null)?.path;
    return typeof path === "string" && text(path).startsWith("<SCRATCH>");
  };
  /**
   * An operator-sourced list: the scenario's own entries, such as a skill it
   * wrote beside its repo, kept and scrubbed, then one neutral entry for all
   * the rest (`scrubbedEntry`).
   */
  const operatorList = (list: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
    const operators = list.filter((entry) => !scenarios(entry));
    return [
      ...list.filter(scenarios).map(scrub),
      ...(operators.length === 0 ? [] : [scrubbedEntry(operators[0])]),
    ];
  };
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) {
      const tools = new Set<string>();
      return value.flatMap((entry) => {
        if (typeof entry !== "string") return [scrub(entry)];
        if (context.entries.has(entry)) return [context.entries.get(entry)];
        const tool = serverTool(entry);
        if (tool === undefined) return [scrub(entry)];
        if (tools.has(tool)) return [];
        tools.add(tool);
        return [tool];
      });
    }
    if (value !== null && typeof value === "object") {
      const { name: named, source } = value as { readonly name?: unknown; source?: unknown };
      if (typeof named === "string" && context.entries.has(named)) {
        const stand = context.entries.get(named)!;
        return scrub({
          ...value,
          name: stand,
          ...("description" in value ? { description: `${stand} (user)` } : {}),
          ...(typeof source === "string" && source.startsWith(`${named}@`)
            ? { source: `${stand}${source.slice(named.length)}` }
            : {}),
        });
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          text(key),
          typeof entry === "string" && SECRET_KEY.test(key)
            ? "<REDACTED>"
            : Array.isArray(entry) && OPERATOR_LIST_KEY.test(key)
              ? operatorList(entry)
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
  /** The SDK that drove the harness; left out of the manifest when there is none. */
  readonly sdkVersion?: string;
  /** Defaults to `sdk-stream`. */
  readonly transport?: StdioTransport;
  /**
   * Which launches are runs rather than one-shot probes like `--version`; the
   * first one's working directory places the scratch root. Defaults to an argv
   * holding `stream-json`.
   */
  readonly isStreamRun?: (argv: ReadonlyArray<string>) => boolean;
  /**
   * Names of the operator's own that the capture carries — their MCP servers,
   * skills the config directory does not hold. Each becomes `user-skill-<n>`
   * wherever it stands alone: a list item, an object's `name`, a key, a word.
   */
  readonly operatorNames?: ReadonlyArray<string>;
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
  /** The system temp directory, scrubbed to `<TMP>`; defaults to `os.tmpdir()`. */
  readonly tmpdir?: string;
  /** The machine's name, scrubbed to `<HOST>`; defaults to `os.hostname()`. */
  readonly hostname?: string;
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

/** The calendar date where the recording was made, not UTC's. */
const localDate = (now: Date): string =>
  [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");

const isStreamJson = (argv: ReadonlyArray<string>): boolean => argv.includes("stream-json");

/**
 * Writes `fixtures/<kind>/<scenario>/` from a raw directory the tee filled:
 * `manifest.json`, and one scrubbed `invocation-<n>.ndjson` per launch. The
 * scenario directory is replaced whole. Returns its path.
 */
export const finalizeStdioRecording = (options: FinalizeOptions): string => {
  const invocations = readRawInvocations(options.rawDir);
  const home = options.home ?? NodeOS.homedir();
  const isStreamRun = options.isStreamRun ?? isStreamJson;
  const firstStream = invocations.find((invocation) => isStreamRun(invocation.argv));
  const operatorNames = (options.operatorNames ?? []).filter((name) => name.length > 0);
  const frames = invocations.flatMap((invocation) => invocation.frames);
  const captured = capturedOperatorNames(frames);
  const scrub = makeScrubber({
    home,
    scratch: options.scratch ?? scratchOf(firstStream?.cwd, home),
    tmp: options.tmpdir ?? NodeOS.tmpdir(),
    username: options.username ?? NodeOS.userInfo().username,
    account: accountValues(frames),
    entries: withOperatorNames(
      operatorEntries(options.configDir ?? NodePath.join(home, ".claude")),
      [...operatorNames, ...captured.servers, ...captured.plugins],
    ),
    operatorNames,
    operatorServers: captured.servers,
    hostname: options.hostname ?? NodeOS.hostname(),
  });

  const dir = NodePath.join(fixturesRoot(options.kind, options.fixturesRoot), options.scenario);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });

  const listed = invocations.map((invocation, index): StdioInvocation => {
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

  const manifest: RecordingManifest & StdioManifestExtra = {
    formatVersion: 1,
    kind: options.kind,
    transport: options.transport ?? "sdk-stream",
    scenario: options.scenario,
    description: options.description,
    cliVersion: options.cliVersion,
    ...(options.sdkVersion === undefined ? {} : { sdkVersion: options.sdkVersion }),
    recordedOn: options.recordedOn ?? localDate(new Date()),
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

/** Finalises an `sdk-stream` recording; see `finalizeStdioRecording`. */
export const finalizeSdkStreamRecording = (options: FinalizeOptions): string =>
  finalizeStdioRecording(options);

// ── reading one back ───────────────────────────────────────────

/** A tee-recorded scenario with each invocation's frames. */
export interface StdioRecording<Extra extends StdioManifestExtra = StdioManifestExtra> {
  readonly manifest: RecordingManifest & Extra;
  /** Each invocation with its frames, in launch order. */
  readonly invocations: ReadonlyArray<
    StdioInvocation & { readonly frames: ReadonlyArray<RecordedFrame> }
  >;
}

export type SdkStreamRecording = StdioRecording<SdkStreamManifestExtra>;

/**
 * Reads one tee-recorded scenario of `transport`. Throws rather than
 * degrading: a manifest that is not real, not this transport, or lists a file
 * that does not parse is a recording nobody should be testing against.
 */
export const loadStdioRecording = <Extra extends StdioManifestExtra = StdioManifestExtra>(
  transport: StdioTransport,
  kind: string,
  scenario: string,
  root?: string,
): StdioRecording<Extra> => {
  const manifest = readManifest<Extra>(kind, scenario, root);
  if (manifest.transport !== transport) {
    throw new Error(`${kind}/${scenario}: recorded over ${manifest.transport}, not ${transport}`);
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

/** Reads one `sdk-stream` recording; see `loadStdioRecording`. */
export const loadSdkStreamRecording = (
  kind: string,
  scenario: string,
  root?: string,
): SdkStreamRecording =>
  loadStdioRecording<SdkStreamManifestExtra>("sdk-stream", kind, scenario, root);
