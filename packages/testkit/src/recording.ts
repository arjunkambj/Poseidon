/**
 * What a recording of a real harness is, whatever wire it was taken from.
 *
 * Every connector is tested against captures of its real harness, never a
 * stand-in. The captures differ by transport — Command Code prints NDJSON on
 * stdout, other harnesses speak JSON-RPC over stdio, stream from an SDK, or
 * answer over HTTP with server-sent events — but they share one layout and one
 * index, so a suite can list, load and assert against any of them the same way:
 *
 * - `packages/testkit/fixtures/<kind>/<scenario>/manifest.json` indexes one
 *   recorded scenario of the harness the connector kind drives. The files
 *   beside it are that transport's own capture.
 * - A manifest names its `formatVersion` and `transport`. The Command Code
 *   recordings predate both fields and are never edited, so a manifest without
 *   them reads as version 1 of its kind's legacy layout.
 * - A `RecordedFrame` is one unit on the wire, tagged with which way it went.
 *
 * Each transport brings its own `Replayer`, which turns a scenario into
 * whatever a connector instance needs to talk to the recording instead of the
 * harness.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const FIXTURES = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

/** The manifest format this module reads. */
export const RECORDING_FORMAT_VERSION = 1;

/**
 * How the harness talked to its connector when the recording was taken.
 *
 * The last two are the browser's: `cdp-websocket` is agent-browser's CDP
 * traffic through the desktop's browser bridge, and `cli-json` is its
 * `--json` command envelopes. agent-browser is a tool the server drives rather
 * than a connector's harness, but it is recorded and replayed by the same
 * rules, under `fixtures/agent-browser/`.
 */
export type RecordingTransport =
  | "stdio-ndjson"
  | "stdio-jsonrpc"
  | "sdk-stream"
  | "http-sse"
  | "cdp-websocket"
  | "cli-json";

/** One unit on the wire, in the order it was captured. */
export interface RecordedFrame {
  /** Which way it travelled: out of the harness, or into it. */
  readonly dir: "from-harness" | "to-harness";
  /** The stream it travelled on, named by the transport ("stdout", "hook", …). */
  readonly channel: string;
  /** Milliseconds from the start of the run, when the capture has them. */
  readonly at?: number;
  readonly data: unknown;
}

/** The fields every recording's manifest has, once defaults are applied. */
export interface RecordingManifest {
  readonly formatVersion: number;
  readonly kind: string;
  readonly transport: RecordingTransport;
  readonly scenario: string;
  readonly description: string;
  readonly cliVersion: string;
  readonly recordedOn?: string;
  readonly model: string;
  readonly real: true;
}

/**
 * The transport each kind recorded before manifests named one. A kind that is
 * not listed here has to name its transport in every manifest.
 */
const LEGACY_TRANSPORTS: Readonly<Record<string, RecordingTransport>> = {
  cmd: "stdio-ndjson",
};

/**
 * Where a connector kind's recordings live: `packages/testkit/fixtures/<kind>/`.
 * `root` stands in for `packages/testkit/fixtures` — a test that exercises the
 * recording machinery itself writes its captures under a temp directory, never
 * beside the real ones.
 */
export const fixturesRoot = (kind: string, root: string = FIXTURES): string =>
  NodePath.join(root, kind);

/**
 * Every recorded scenario of a kind, by name. A scenario is a directory holding
 * a `manifest.json` with turns; the probe captures sit in their own directory
 * and are not a scenario, and a directory with no manifest (config files a
 * connector reads, say) is not a recording at all.
 */
export const recordingNames = (kind: string, root?: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(fixturesRoot(kind, root), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "probe" &&
        NodeFS.existsSync(NodePath.join(fixturesRoot(kind, root), entry.name, "manifest.json")),
    )
    .map((entry) => entry.name)
    .sort();

/**
 * Reads a scenario's manifest. Throws rather than degrading: a manifest that is
 * not marked real, names a format this module does not read, or names no
 * transport its kind can default to is one nobody should be testing against.
 * `Extra` is the rest of the manifest as that transport's layout writes it.
 */
export const readManifest = <Extra extends object = Record<string, unknown>>(
  kind: string,
  scenario: string,
  root?: string,
): RecordingManifest & Extra => {
  const raw = JSON.parse(
    NodeFS.readFileSync(NodePath.join(fixturesRoot(kind, root), scenario, "manifest.json"), "utf8"),
  ) as Partial<RecordingManifest> & { readonly real?: unknown } & Extra;
  if (raw.real !== true) {
    throw new Error(`${kind}/${scenario}: not marked as a real recording`);
  }
  const formatVersion = raw.formatVersion ?? RECORDING_FORMAT_VERSION;
  if (formatVersion !== RECORDING_FORMAT_VERSION) {
    throw new Error(`${kind}/${scenario}: recording format ${formatVersion} is not readable`);
  }
  const transport = raw.transport ?? LEGACY_TRANSPORTS[kind];
  if (transport === undefined) {
    throw new Error(`${kind}/${scenario}: the manifest names no transport`);
  }
  return {
    ...raw,
    formatVersion,
    kind,
    transport,
    scenario: raw.scenario ?? scenario,
    description: raw.description ?? "",
    cliVersion: raw.cliVersion ?? "unknown",
    model: raw.model ?? "unknown",
    real: true,
  };
};

/**
 * A scenario's frames from a JSON-lines capture beside its manifest
 * (`frames.jsonl` unless named), in the order they were captured. The
 * manifest is read first, so a recording that is not marked real never
 * yields a frame.
 */
export const readFrames = (
  kind: string,
  scenario: string,
  file = "frames.jsonl",
): ReadonlyArray<RecordedFrame> => {
  readManifest(kind, scenario);
  return NodeFS.readFileSync(NodePath.join(fixturesRoot(kind), scenario, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedFrame);
};

/**
 * Puts a kind's recordings back on its transport. `config` answers whatever a
 * connector instance needs to talk to the recording instead of the harness — a
 * binary and environment for a process, a URL for a server.
 */
export interface Replayer<Options, Config = unknown> {
  readonly kind: string;
  readonly transport: RecordingTransport;
  readonly config: (scenario: string, options: Options) => Config;
}
