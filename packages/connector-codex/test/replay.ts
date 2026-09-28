/**
 * A recorded scenario, put back behind a binary path.
 *
 * The connector keeps its real code — the spawn, the JSON-RPC client, the
 * handshake; only the binary changes, to the testkit's replayer for
 * `fixtures/codex/<scenario>/`. Each replayed process drops a file named
 * after its pid into `pidDir`, so a test can check that every process the
 * connector started is gone.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { stdioJsonRpcReplayer } from "@poseidon/testkit/replayStdioJsonRpc";

import { CODEX_KIND } from "../src/kind";

export interface Replay {
  readonly binaryPath: string;
  /** Every replayed process that has been started. */
  readonly pids: () => ReadonlyArray<number>;
  /** Throws with what the replayer said if any replayed process diverged. */
  readonly assertPlayedOut: () => void;
}

export const replay = (scenario: string): Replay => {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `codex-replay-${scenario}-`));
  const pidDir = NodePath.join(tmpDir, "pids");
  const divergenceLog = NodePath.join(tmpDir, "diverged.log");
  const { binaryPath } = stdioJsonRpcReplayer(CODEX_KIND).config(scenario, {
    tmpDir,
    pidDir,
    divergenceLog,
  });
  return {
    binaryPath,
    pids: () =>
      NodeFS.existsSync(pidDir) ? NodeFS.readdirSync(pidDir).map((name) => Number(name)) : [],
    assertPlayedOut: () => {
      if (NodeFS.existsSync(divergenceLog)) {
        throw new Error(NodeFS.readFileSync(divergenceLog, "utf8"));
      }
    },
  };
};

/** The process is gone: signal 0 fails with ESRCH. */
export const isPidGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};
