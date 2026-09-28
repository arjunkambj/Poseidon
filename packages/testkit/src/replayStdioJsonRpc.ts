/**
 * A `stdio-jsonrpc` recording, put back on the wire as if it were the CLI.
 *
 * `bin/replay-stdio-jsonrpc.mjs` is the process; this is what points a
 * connector at it. The connector keeps its real code — only the binary path
 * changes — so a replay exercises the whole JSON-RPC round trip minus the
 * model, and the model's half is the recording.
 *
 * As with `sdk-stream`, the connector's child environment is default-deny, so
 * `config` bakes the scenario into a launcher of its own in the test's temp
 * directory and returns it as the binary path. Each launch plays the next
 * recorded invocation of its class — `--version`, `login status`, a probe's
 * server-mode handshake, a session's server-mode run — counted in a state file
 * beside it, so the second session of a resume-after-restart test gets the
 * second recorded run whatever the probes did in between.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { fixturesRoot, readManifest, type Replayer } from "./recording";
import { REPLAY_DIVERGED, type SdkStreamReplayOptions } from "./replaySdkStream";
import { writeNodeLauncher } from "./sdkStreamRecording";

export { REPLAY_DIVERGED };

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

/** The replaying process a launcher runs. */
const REPLAY_SCRIPT = NodePath.join(HERE, "..", "bin", "replay-stdio-jsonrpc.mjs");

/** Where the launcher goes, and the optional pid directory and divergence log. */
export type StdioJsonRpcReplayOptions = SdkStreamReplayOptions;

export interface StdioJsonRpcReplayConfig {
  /** Point the connector instance's binary path here. */
  readonly binaryPath: string;
}

/**
 * The `stdio-jsonrpc` replayer for one connector kind. `root` stands in for
 * `packages/testkit/fixtures`, for tests of the replayer itself.
 */
export const stdioJsonRpcReplayer = (
  kind: string,
  root?: string,
): Replayer<StdioJsonRpcReplayOptions, StdioJsonRpcReplayConfig> => ({
  kind,
  transport: "stdio-jsonrpc",
  config: (scenario, options) => {
    // Read once here so a recording that is not real, or not this transport,
    // fails in the test that names it rather than inside a spawned child.
    const manifest = readManifest(kind, scenario, root);
    if (manifest.transport !== "stdio-jsonrpc") {
      throw new Error(
        `${kind}/${scenario}: recorded over ${manifest.transport}, not stdio-jsonrpc`,
      );
    }
    const tmpDir = NodePath.resolve(options.tmpDir);
    NodeFS.mkdirSync(tmpDir, { recursive: true });
    const configFile = NodePath.join(tmpDir, `replay-${kind}-${scenario}.json`);
    NodeFS.writeFileSync(
      configFile,
      `${JSON.stringify(
        {
          scenarioDir: NodePath.join(fixturesRoot(kind, root), scenario),
          stateFile: NodePath.join(tmpDir, `replay-${kind}-${scenario}.state.json`),
          ...(options.pidDir === undefined ? {} : { pidDir: NodePath.resolve(options.pidDir) }),
          ...(options.divergenceLog === undefined
            ? {}
            : { divergenceLog: NodePath.resolve(options.divergenceLog) }),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      binaryPath: writeNodeLauncher(
        NodePath.join(tmpDir, `replay-${kind}-${scenario}`),
        REPLAY_SCRIPT,
        configFile,
      ),
    };
  },
});
