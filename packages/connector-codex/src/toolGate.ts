/**
 * Every approval the app-server asks for goes past Poseidon's permission
 * ladder, through the shared approval gate (`makeApprovalGate`).
 *
 * The app-server asks its client directly: a server request per command it
 * does not count as safe, and per file change (`approvals.ts` maps both). The
 * session keeps the approval policy `untrusted` in every mode (`modes.ts`), so
 * the CLI asks and the ladder — not the CLI — decides what a mode allows. The
 * gate asks `permissions.decide`; allow and deny answer at once, and prompt
 * opens a card and waits for the user. The ladder's and the card's answers
 * read to the CLI as:
 *
 * - allow (the rules), allow once, allow always, allow for the session →
 *   `accept`. "Always" and "for the session" are Poseidon's rules, which the
 *   server has already saved; nothing is written to the CLI's own
 *   configuration. The CLI's own `acceptForSession` is never sent: the CLI
 *   would then run the same call unasked, past the ladder — and the recorded
 *   command approvals do not offer it (`availableDecisions`). So the CLI asks
 *   again, and the session rule answers at once with no card.
 * - deny → `decline`: the call does not run, and the model is told so. An
 *   open card answered by Stop is `cancel`, which also ends the CLI's turn.
 *
 * A file change touching several paths is one card per path; the change runs
 * only if every path is allowed.
 *
 * An MCP tool call is asked about as an elicitation (`mcpApprovals.ts`): the
 * gate answers it the same way, in the elicitation's own words — `accept`,
 * `decline`, or `cancel` for Stop.
 *
 * The CLI can withdraw a request it is still waiting on — the turn it belongs
 * to was interrupted or ended, and `serverRequest/resolved` names a request
 * the session never answered. The gate's signal for that request is aborted,
 * so its card resolves `deny`, and nothing is sent back: nobody is waiting.
 * Closing the session does the same for every open card.
 *
 * It fails closed. A defect inside the ladder is a prompt (the shared gate);
 * anything else that goes wrong while answering answers `decline`.
 *
 * What reaches it: on the recording machine (0.156.1, a zsh login shell)
 * the CLI asked about every command, reads included — `sensitive-full-access`
 * shows `cat .env` under full access stopped for approval and declined, and
 * `ls` and `cat README.md` asked the same way. The CLI does keep a list of
 * known-safe reads it may run without asking under `untrusted`; where it
 * applies, those reads never reach the ladder. So every item that ran with no
 * request for it is counted: a file change, or a command that is not one of
 * those reads (`isKnownSafeCommand`), ends the turn with a `session.warning`
 * saying the turn was not fully gated (`ungatedWarning`). So is a file the
 * turn's diff shows written with no file-change item for it (`turnWrites.ts`):
 * a patch the CLI applied from inside its scripted `exec` tool once did that,
 * with no request and no item. A known-safe read that ran unasked is not
 * warned about: that is the gap left open, and it is the CLI's to close, not
 * the ladder's.
 */

import type { ApprovalGate, ApprovalVerdict } from "@poseidon/connector-sdk/approvalGate";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { ApprovalRequest } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";

import {
  COMMAND_APPROVAL,
  commandApprovalRequest,
  FILE_CHANGE_APPROVAL,
  fileChangeApprovalRequests,
  makeFileChangePaths,
  unwrapShell,
} from "./approvals";
import {
  elicitationOutcome,
  isMcpToolApproval,
  makeMcpToolCalls,
  MCP_ELICITATION,
  mcpToolApprovalRequest,
} from "./mcpApprovals";
import type { RpcId, RpcOutcome, RpcServerRequest } from "./rpc";
import { asArray, asRecord, asString, type Notification } from "./translate/pending";
import { makeTurnWrites } from "./turnWrites";

/** How the CLI spells each answer Poseidon gives to a command or file-change approval. */
export type CodexApprovalAnswer = "accept" | "decline" | "cancel";

/** The approval requests the gate answers. */
const GATED_METHODS: ReadonlySet<string> = new Set([COMMAND_APPROVAL, FILE_CHANGE_APPROVAL]);

/** Whether the gate answers `request`: an approval, or the CLI asking to run an MCP tool. */
export const isGatedRequest = (request: RpcServerRequest): boolean =>
  GATED_METHODS.has(request.method) ||
  (request.method === MCP_ELICITATION && isMcpToolApproval(request.params));

/** The wire answer to `request` for one of the gate's answers. */
const outcomeFor = (request: RpcServerRequest, answer: CodexApprovalAnswer): RpcOutcome =>
  request.method === MCP_ELICITATION
    ? elicitationOutcome(answer)
    : { result: { decision: answer } };

/** What one verdict of the gate answers the CLI. */
export const answerFor = (verdict: ApprovalVerdict): CodexApprovalAnswer =>
  verdict.allowed ? "accept" : "decline";

/**
 * The answer to a request the gate decided in parts — a file change, one card
 * per path: any refusal declines it.
 */
export const combineAnswers = (answers: ReadonlyArray<CodexApprovalAnswer>): CodexApprovalAnswer =>
  answers.length === 0 || answers.some((answer) => answer === "decline") ? "decline" : "accept";

/**
 * The commands the CLI runs without asking under `untrusted`, by first word:
 * reads that change nothing. A command outside this list that ran without a
 * request is one the CLI should have asked about.
 */
const KNOWN_SAFE_COMMANDS = new Set([
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "find",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "rg",
  "sed",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);
const KNOWN_SAFE_GIT = new Set(["status", "log", "diff", "show", "branch"]);

/** Whether every command of a line is one the CLI runs without asking. */
export const isKnownSafeCommand = (command: string): boolean =>
  unwrapShell(command)
    .split(/&&|\|\||[|;]/)
    .map((part) => part.trim().split(/\s+/))
    .every(([first, second]) => {
      if (first === undefined || first === "") return true;
      if (first === "git") return second !== undefined && KNOWN_SAFE_GIT.has(second);
      return KNOWN_SAFE_COMMANDS.has(first);
    });

/**
 * What the thread is told when a turn's calls ran without reaching the gate,
 * or its diff wrote files no file change was asked about.
 */
export const ungatedWarning = (ran: number, written = 0): string => {
  const what = [
    ...(ran > 0 ? [`${ran} call(s) ran`] : []),
    ...(written > 0 ? [`${written} file(s) were written`] : []),
  ].join(" and ");
  return `${what} without reaching Poseidon's approval gate — Codex did not ask, so this turn was not fully gated`;
};

export interface CodexToolGate {
  /** Reads a notification before it is translated. */
  readonly observe: (notification: Notification) => Effect.Effect<void>;
  /**
   * The answer to one approval request: waits on the ladder and, when it
   * prompts, on the card. `null` when the CLI withdrew the request, and
   * nothing is to be sent. It never fails. The request counts as open from
   * the call, before the effect runs.
   */
  readonly answer: (request: RpcServerRequest) => Effect.Effect<RpcOutcome | null>;
  /**
   * Stops the turn's open cards: each resolves `deny`, and its request is
   * answered `cancel`, which ends the CLI's turn too.
   */
  readonly cancelAll: Effect.Effect<void>;
  /**
   * The session is closing: each open card resolves `deny`, and nothing more
   * is sent — the process that asked is on its way out.
   */
  readonly closeAll: Effect.Effect<void>;
  /** A new turn: forgets the last one's items and ends a Stop's cancelling. */
  readonly turnStarted: Effect.Effect<void>;
  /** The warning for the turn just ended, if calls ran without the gate. */
  readonly ungated: () => string | undefined;
}

export const makeCodexToolGate = (options: {
  readonly threadId: ThreadId;
  readonly gate: ApprovalGate;
  /** The thread's settings as they are now — read per request, never captured. */
  readonly settings: () => ThreadSettings;
}): CodexToolGate => {
  const paths = makeFileChangePaths();
  const mcpCalls = makeMcpToolCalls();
  const writes = makeTurnWrites();
  /** Each request still waiting on the gate, by its JSON-RPC id. */
  const open = new Map<string, AbortController>();
  /**
   * The CLI's items a request reached the gate for. Kept for the session: a
   * stopped turn's item can complete after the next turn has started.
   */
  const gatedItems = new Set<string>();
  let ranUngated = 0;
  let cancelling = false;
  let closing = false;

  const keyOf = (id: RpcId): string => String(id);

  const decide = (request: ApprovalRequest, signal: AbortSignal) =>
    Effect.suspend(() => {
      const settings = options.settings();
      return options.gate.decide({
        request,
        threadId: options.threadId,
        runtimeMode: settings.runtimeMode,
        interactionMode: settings.interactionMode,
        signal,
      });
    });

  /** The gate's answers for one request, one per approval request it maps to. */
  const decideAll = (
    requests: ReadonlyArray<ApprovalRequest>,
    signal: AbortSignal,
  ): Effect.Effect<CodexApprovalAnswer> =>
    Effect.gen(function* () {
      const answers: Array<CodexApprovalAnswer> = [];
      for (const request of requests) {
        const answer = answerFor(yield* decide(request, signal));
        answers.push(answer);
        // The first refusal decides the change; no further card is opened.
        if (answer === "decline") break;
      }
      return combineAnswers(answers);
    });

  const answer = (rpcRequest: RpcServerRequest): Effect.Effect<RpcOutcome | null> => {
    // Registered now, when the session hands the request over, not when the
    // returned effect first runs on its fiber: a withdrawal or a turn's end
    // that the consumer reads next must already find it open.
    const params = asRecord(rpcRequest.params);
    const itemId = asString(params.itemId);
    if (itemId !== undefined) gatedItems.add(itemId);
    const controller = new AbortController();
    const key = keyOf(rpcRequest.id);
    open.set(key, controller);
    return Effect.suspend(() =>
      decideAll(
        rpcRequest.method === COMMAND_APPROVAL
          ? [commandApprovalRequest(params)]
          : rpcRequest.method === MCP_ELICITATION
            ? [mcpToolApprovalRequest(params, mcpCalls)]
            : fileChangeApprovalRequests(params, paths.pathsOf),
        controller.signal,
      ),
    ).pipe(
      Effect.map((decided): RpcOutcome | null => {
        if (controller.signal.aborted || closing) return null;
        const final = decided === "decline" && cancelling ? "cancel" : decided;
        return outcomeFor(rpcRequest, final);
      }),
      Effect.catchCause(() => Effect.succeed(outcomeFor(rpcRequest, "decline"))),
      Effect.ensuring(Effect.sync(() => open.delete(key))),
    );
  };

  /** An item that ran with no request for it, and was one the CLI should have asked about. */
  const countUngated = (item: Readonly<Record<string, unknown>>) => {
    const id = asString(item.id);
    if (id === undefined || gatedItems.has(id)) return;
    const type = asString(item.type);
    // Only what actually ran: a change applied, a command that exited. A call
    // declined, or failed before it ran — a stopped turn's — changed nothing.
    if (type === "fileChange") {
      if (asString(item.status) === "completed" && asArray(item.changes).length > 0) {
        ranUngated += 1;
      }
      return;
    }
    if (type === "commandExecution" && asString(item.source) !== "userShell") {
      if (typeof item.exitCode !== "number") return;
      if (!isKnownSafeCommand(asString(item.command) ?? "")) ranUngated += 1;
    }
  };

  const observe = (notification: Notification): Effect.Effect<void> =>
    Effect.sync(() => {
      const params = asRecord(notification.params);
      paths.observe(notification.method, params);
      mcpCalls.observe(notification.method, params);
      writes.observe(notification.method, params);
      switch (notification.method) {
        case "item/completed":
          countUngated(asRecord(params.item));
          return;
        case "serverRequest/resolved": {
          const requestId = params.requestId;
          if (typeof requestId !== "string" && typeof requestId !== "number") return;
          // Still open: the CLI stopped waiting before the session answered.
          open.get(keyOf(requestId))?.abort();
          return;
        }
        case "turn/completed":
          // Whatever the CLI still had open died with its turn.
          for (const controller of open.values()) controller.abort();
          return;
      }
    });

  return {
    observe,
    answer,
    cancelAll: Effect.suspend(() => {
      cancelling = true;
      return options.gate.releaseAll("deny");
    }),
    closeAll: Effect.suspend(() => {
      closing = true;
      return options.gate.releaseAll("deny");
    }),
    turnStarted: Effect.sync(() => {
      cancelling = false;
      ranUngated = 0;
      paths.clear();
      mcpCalls.clear();
      writes.clear();
    }),
    ungated: () => {
      const written = writes.unaccounted();
      return ranUngated === 0 && written === 0 ? undefined : ungatedWarning(ranUngated, written);
    },
  };
};
