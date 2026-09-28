/**
 * What one Command Code session is opened with. Its own module so the
 * session file stays within its size limit.
 */

import type { ConnectorInstanceId, ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { ConnectorServices } from "@poseidon/connector-sdk/definition";

import type { ResolvedBinary } from "./binary";
import type { CmdSessionRef } from "./sessionRef";

export interface CmdSessionOptions {
  readonly instanceId: ConnectorInstanceId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly binaryPath?: string;
  /**
   * The executable the probe resolved — command plus the npx fallback's prefix
   * args. Omitted, the session resolves it itself the same way.
   */
  readonly binary?: ResolvedBinary;
  /**
   * Tokens the model can hold. Defaults to what the last probe of this binary
   * reported; a test passes it outright.
   */
  readonly contextLimit?: number | null;
  readonly extraEnv?: Record<string, string>;
  readonly services: ConnectorServices;
  readonly settings: ThreadSettings;
  readonly sessionRef?: CmdSessionRef;
  /**
   * Fork `sessionRef` instead of resuming it: the first turn runs with
   * `--fork-session`, the harness copies the conversation into a new session
   * and leaves this one as it was (`fixtures/cmd/fork/`). Every later turn
   * resumes the new session.
   */
  readonly fork?: boolean;
  /**
   * Home directory override for transcript resolution. The harness resolves
   * `~/.commandcode` against `HOME` alone, so a test that points the
   * child's `HOME` aside passes the same directory here.
   */
  readonly home?: string;
}
