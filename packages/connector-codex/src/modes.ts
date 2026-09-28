/**
 * Poseidon's runtime modes as the app-server's approval and sandbox policies.
 *
 * The approval policy is `untrusted` in every mode: the CLI then asks before
 * anything it does not consider safe, and each ask reaches Poseidon's
 * permission ladder as a server request (`item/commandExecution/
 * requestApproval`, `item/fileChange/requestApproval`). The ladder, not the
 * CLI, decides what a mode allows — so full access still opens a card for a
 * sensitive path. The obvious mapping, full access as `never`, would hide
 * every call from the ladder and never ask about anything.
 *
 * `untrusted` still lets the CLI run the commands it counts as known-safe
 * reads (`cat`, `ls`, …) without asking; `docs/codex-connector.md` says what
 * that leaves ungated.
 *
 * Only the sandbox varies, as the OS-level backstop under the ladder: the
 * workspace is writable in the two asking modes, and full access lifts it.
 * `thread/start` takes the sandbox by name; `turn/start` wants the policy
 * spelled out, so the two forms live side by side.
 */

import type { RuntimeMode } from "@poseidon/contracts/enums";

export type ApprovalPolicy = "untrusted";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export const APPROVAL_POLICY: ApprovalPolicy = "untrusted";

export const sandboxModeFor = (mode: RuntimeMode): SandboxMode => {
  switch (mode) {
    case "full-access":
      return "danger-full-access";
    case "approval-required":
    case "auto-accept-edits":
      return "workspace-write";
  }
};

/** The sandbox as `turn/start`'s `sandboxPolicy` spells it. */
export const sandboxPolicyFor = (mode: RuntimeMode): Readonly<Record<string, unknown>> => {
  switch (sandboxModeFor(mode)) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
};
