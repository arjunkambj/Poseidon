/**
 * The requests the app-server makes of its client, and what a session
 * answers until each has a card of its own.
 *
 * Every server request is answered — a request left unanswered holds the
 * turn up for good. The two approvals are declined: nothing may run on an answer the user never gave, and the model
 * is told it was refused. Every other request is answered "not handled",
 * which the CLI treats as the client declining it.
 */

import type { RpcOutcome, RpcServerRequest } from "./rpc";
import { METHOD_NOT_FOUND } from "./rpc";

/**
 * The approval requests, by method, and how the CLI spells no. The legacy
 * `execCommandApproval` and `applyPatchApproval` go only to clients of the
 * older protocol, which this is not.
 */
export const APPROVAL_METHODS: Readonly<Record<string, unknown>> = {
  "item/commandExecution/requestApproval": "decline",
  "item/fileChange/requestApproval": "decline",
};

export const declineOutcome = (request: RpcServerRequest): RpcOutcome => {
  const decision = APPROVAL_METHODS[request.method];
  return decision === undefined
    ? { error: { code: METHOD_NOT_FOUND, message: `${request.method} is not handled` } }
    : { result: { decision } };
};
