/**
 * The requests the app-server makes of its client that no card answers yet,
 * and the safe refusal each gets.
 *
 * Every server request is answered — a request left unanswered holds the
 * turn up for good. The command and file-change approvals go to the approval
 * gate (`toolGate.ts`); what is left here is answered with the refusal that
 * lets nothing happen:
 *
 * - `item/permissions/requestApproval` — the model asks for more sandbox
 *   (network, extra writable roots). It is granted nothing, for this turn:
 *   Poseidon's modes set the sandbox, and a card of its own is not built.
 * - `mcpServer/elicitation/request` — an MCP server asks the user for input.
 *   It is declined.
 * - `execCommandApproval` and `applyPatchApproval` — the approvals of the
 *   older protocol, which the CLI sends only to clients of that protocol, not
 *   to this one. Should one come, it is denied.
 *
 * Each of those says so on the thread (`warning`), since the model was
 * refused something the user never saw. Anything else is answered "not
 * handled", which the CLI treats as the client declining it.
 */

import type { RpcOutcome, RpcServerRequest } from "./rpc";
import { METHOD_NOT_FOUND } from "./rpc";

export interface Refusal {
  readonly outcome: RpcOutcome;
  /** What the thread is told, when the refusal is one the user should know of. */
  readonly warning?: string;
}

const LEGACY_DENIAL = {
  result: { decision: { denied: { rejection: "Poseidon does not answer this approval form." } } },
};

export const refusalFor = (request: RpcServerRequest): Refusal => {
  switch (request.method) {
    case "item/permissions/requestApproval":
      return {
        outcome: { result: { permissions: {}, scope: "turn" } },
        warning:
          "Codex asked for more sandbox permissions than the thread's mode gives; none were granted",
      };
    case "mcpServer/elicitation/request":
      return {
        outcome: { result: { action: "decline", content: null, _meta: null } },
        warning: "An MCP server asked Codex for input from the user; Poseidon declined it",
      };
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        outcome: LEGACY_DENIAL,
        warning: `Codex sent an approval of its older protocol (${request.method}); it was denied`,
      };
    default:
      return {
        outcome: {
          error: { code: METHOD_NOT_FOUND, message: `${request.method} is not handled` },
        },
      };
  }
};
