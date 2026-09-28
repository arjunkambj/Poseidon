/**
 * Recording a harness that speaks JSON-RPC over stdio — the `stdio-jsonrpc`
 * transport — at the process boundary.
 *
 * The connector spawns the CLI's server mode and the two exchange one JSON-RPC
 * message per line: the connector's requests and notifications and its answers
 * to the harness's own requests (approvals, questions) on stdin; the harness's
 * responses, notifications and requests on stdout. That is NDJSON like the
 * `sdk-stream` wire, so it is captured by the same tee (`makeTeeLauncher`) and
 * finalised by the same finaliser, with this transport's defaults:
 *
 * - a run is a launch whose argv holds `app-server`; a probe's run is one that
 *   also holds `STDIO_JSONRPC_PROBE_MARKER`, and the scratch root is placed
 *   from the first run that is not a probe's;
 * - the manifest names no SDK: `prompts`, `invocations[]` and the CLI version.
 *
 * The replay half is `replayStdioJsonRpc.ts`.
 */

import {
  finalizeStdioRecording,
  loadStdioRecording,
  type FinalizeOptions,
  type StdioManifestExtra,
  type StdioRecording,
} from "./sdkStreamRecording";

/**
 * The argv word a connector's probe adds to its server-mode launch, so a
 * recording and its replay can tell a probe's handshake from a session. It is
 * the CLI's own flag for the transport it uses by default, so it changes
 * nothing about the run. `bin/replay-stdio-jsonrpc.mjs` spells it the same.
 */
export const STDIO_JSONRPC_PROBE_MARKER = "--stdio";

/** The argv word of a launch that serves JSON-RPC on stdio. */
const SERVER_MODE = "app-server";

const isSessionRun = (argv: ReadonlyArray<string>): boolean =>
  argv.includes(SERVER_MODE) && !argv.includes(STDIO_JSONRPC_PROBE_MARKER);

/** The fields a `stdio-jsonrpc` manifest adds to the common ones. */
export type StdioJsonRpcManifestExtra = Omit<StdioManifestExtra, "sdkVersion">;

export type StdioJsonRpcRecording = StdioRecording<StdioJsonRpcManifestExtra>;

/**
 * Writes `fixtures/<kind>/<scenario>/` from a raw directory the tee filled, as
 * a `stdio-jsonrpc` recording. `operatorNames` names the operator's own MCP
 * servers and skills the capture carries; the rest is `finalizeStdioRecording`.
 */
export const finalizeStdioJsonRpcRecording = (
  options: Omit<FinalizeOptions, "transport" | "sdkVersion">,
): string =>
  finalizeStdioRecording({
    isStreamRun: isSessionRun,
    ...options,
    transport: "stdio-jsonrpc",
  });

/** Reads one `stdio-jsonrpc` recording back with its frames. */
export const loadStdioJsonRpcRecording = (
  kind: string,
  scenario: string,
  root?: string,
): StdioJsonRpcRecording =>
  loadStdioRecording<StdioJsonRpcManifestExtra>("stdio-jsonrpc", kind, scenario, root);
