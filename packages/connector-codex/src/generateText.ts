/**
 * One piece of text written by Codex outside any session: a commit message,
 * a pull request's title and body, a thread title.
 *
 * It is one `codex app-server` of its own, the same JSON-RPC wire a session
 * speaks, asked for exactly one turn:
 *
 * 1. the app-server starts in a directory made for the call under the system
 *    temp directory, with the child's default-deny environment and none of a
 *    session's `-c` overrides — Poseidon's MCP server is not named, and there
 *    is no bearer to hide;
 * 2. `initialize`, then `thread/start` with `ephemeral: true` (the CLI writes
 *    no rollout), the `read-only` sandbox and the approval policy `never`, so
 *    nothing the model tries can write and nothing waits on a card; the
 *    caller's `system` goes in as `developerInstructions`, beside the CLI's
 *    own instructions rather than in place of them;
 * 3. `turn/start` with the prompt as one text input, the model and effort
 *    through `turnSettings.ts` — an effort the model does not offer is
 *    replaced by the model's own, or left out — and `jsonSchema` as the
 *    turn's `outputSchema`, which the CLI holds the final message to;
 * 4. the answer is the last `agentMessage` the turn completed, its
 *    `final_answer` when the CLI marks one, once `turn/completed` arrives;
 * 5. any request the server makes is declined — approvals `decline`, the rest
 *    the refusals a session gives (`serverRequests.ts`) — then stdin is
 *    closed, the process group stopped and the directory removed.
 *
 * The operator's own MCP servers and plugins from `config.toml` still start
 * in the thread: `thread/start`'s `config` merges into the user's tables and
 * cannot empty them (tried on 0.156.1). The read-only sandbox is what keeps
 * the call from writing.
 *
 * A turn that ends anything but `completed`, an `error` the server will not
 * retry, a server that goes away, and an answer with no text all fail with
 * `GenerationFailed` in the CLI's own words. `fixtures/codex/generate-text/`
 * is a recording of exactly this exchange.
 */

import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import {
  GenerationFailed,
  SpawnFailed,
  type ConnectorError,
  type GenerateTextInput,
} from "@poseidon/connector-sdk/definition";
import * as Effect from "effect/Effect";

import type { ResolvedBinary } from "./binary";
import { call, initialize } from "./handshake";
import { CODEX_KIND } from "./kind";
import { codexModelFor, type CodexModelFacts } from "./models";
import { ThreadOpenResponse, TurnStartResponse } from "./protocol";
import { makeRpcClient, type RpcClient, type RpcOutcome, type RpcServerRequest } from "./rpc";
import { refusalFor } from "./serverRequests";
import { makeProcessGroup } from "./spawn";
import { openedFrom, type OpenedThread } from "./threadOpen";
import { asRecord, nonEmpty } from "./translate/pending";
import { holdsOf, turnOverrides, turnTarget } from "./turnSettings";

/** The one-shot app-server's argv: no MCP server, no override of the user's config. */
export const GENERATE_SERVER_ARGS: ReadonlyArray<string> = ["app-server"];

/** What `thread/start` is sent for a one-shot call. */
export const generateThreadParams = (cwd: string, input: GenerateTextInput) => {
  const model = codexModelFor(input.model);
  const system = input.system?.trim() ?? "";
  return {
    cwd,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    ...(model === undefined ? {} : { model }),
    ...(system === "" ? {} : { developerInstructions: system }),
  } as const;
};

/** What `turn/start` is sent: the prompt, the overrides the thread needs, the schema. */
export const generateTurnParams = (
  opened: OpenedThread,
  input: GenerateTextInput,
  factsFor?: (model: string) => CodexModelFacts | undefined,
) => {
  const target = turnTarget({
    settings: {
      model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    },
    opened,
    ...(factsFor === undefined ? {} : { factsFor }),
  });
  return {
    threadId: opened.threadId,
    input: [{ type: "text", text: input.prompt, text_elements: [] }],
    ...turnOverrides(target, holdsOf(opened)).params,
    ...(input.jsonSchema === undefined ? {} : { outputSchema: input.jsonSchema }),
  } as const;
};

/** The answer to a request the server makes of a one-shot call: always no. */
export const declineFor = (request: RpcServerRequest): RpcOutcome => {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    default:
      return refusalFor(request).outcome;
  }
};

/** What the turn left behind, as the notifications told it. */
export interface TurnOutcome {
  /** `completed`, `failed`, `interrupted`; undefined when the server went away first. */
  readonly status?: string;
  /** The turn's own error, else the last `error` the server did not retry. */
  readonly error?: string;
  /** The final answer, else the last agent message completed. */
  readonly text?: string;
  /** Why the connection ended before the turn did. */
  readonly closed?: string;
}

/** The answer's text, or why there is none. */
export const answerOf = (
  outcome: TurnOutcome,
): { readonly text: string } | { readonly failure: string } => {
  if (outcome.status === undefined) {
    return { failure: outcome.error ?? outcome.closed ?? "the app-server ended before the turn" };
  }
  if (outcome.status !== "completed") {
    return { failure: outcome.error ?? `the turn ended ${outcome.status}` };
  }
  const text = outcome.text ?? "";
  return text.trim() === "" ? { failure: "codex answered with no text" } : { text };
};

/** An error's message, with the sign-in hint when the server says the login is gone. */
const errorText = (value: unknown, loginCommand: string): string | undefined => {
  const error = asRecord(value);
  const message = nonEmpty(error.message);
  if (message === undefined) return undefined;
  const details = nonEmpty(error.additionalDetails);
  const text = details === undefined ? message : `${message}\n${details}`;
  return error.codexErrorInfo === "unauthorized"
    ? `${text}\nSign in again with \`${loginCommand}\`.`
    : text;
};

/**
 * Listens for the turn's end from before the first line is read; settles with
 * the outcome once `turn/completed` arrives or the connection ends.
 */
const watchTurn = (rpc: RpcClient, loginCommand: string): Promise<TurnOutcome> => {
  let final: string | undefined;
  let last: string | undefined;
  let error: string | undefined;
  const completed = new Promise<TurnOutcome>((resolve) => {
    rpc.onNotification(({ method, params }) => {
      const body = asRecord(params);
      if (method === "item/completed") {
        const item = asRecord(body.item);
        if (item.type !== "agentMessage" || typeof item.text !== "string") return;
        last = item.text;
        if (item.phase === "final_answer") final = item.text;
      } else if (method === "error" && body.willRetry !== true) {
        error = errorText(body.error, loginCommand) ?? error;
      } else if (method === "turn/completed") {
        const turn = asRecord(body.turn);
        const status = nonEmpty(turn.status) ?? "without a status";
        const turnError = errorText(turn.error, loginCommand) ?? error;
        const text = final ?? last;
        resolve({
          status,
          ...(turnError === undefined ? {} : { error: turnError }),
          ...(text === undefined ? {} : { text }),
        });
      }
    });
  });
  const closed = rpc.closed.then((reason): TurnOutcome => ({
    closed: reason,
    ...(error === undefined ? {} : { error }),
  }));
  return Promise.race([completed, closed]);
};

export interface CodexGenerateTextOptions {
  readonly instanceId: ConnectorInstanceId;
  /** Resolved per call, so an install that appears later is found. */
  readonly launch: Effect.Effect<{
    readonly binary: ResolvedBinary | null;
    readonly env: Record<string, string>;
    readonly loginCommand: string;
  }>;
  /** What the call reports when there is no binary at all. */
  readonly notFound: string;
  /** A model's efforts and default, once the instance has listed its models. */
  readonly modelFacts?: (model: string) => CodexModelFacts | undefined;
}

/** The instance's `generateText`. */
export const makeCodexGenerateText =
  (options: CodexGenerateTextOptions) =>
  (input: GenerateTextInput): Effect.Effect<string, ConnectorError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const fail = (message: string) =>
          new GenerationFailed({ kind: CODEX_KIND, instanceId: options.instanceId, message });
        const spawnFailed = (message: string) =>
          new SpawnFailed({ kind: CODEX_KIND, instanceId: options.instanceId, message });
        const { binary, env, loginCommand } = yield* options.launch;
        if (binary === null) return yield* spawnFailed(options.notFound);
        // Made before the process and removed after it: the scope's finalizers
        // run in reverse, so the process group is gone before the directory is.
        const cwd = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "poseidon-generate-")),
            catch: (cause) => spawnFailed(cause instanceof Error ? cause.message : String(cause)),
          }),
          (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
        );
        const group = yield* Effect.acquireRelease(
          Effect.sync(() => makeProcessGroup()),
          (made) => made.stop,
        );
        const child = group.spawn({
          command: binary.command,
          args: GENERATE_SERVER_ARGS,
          cwd,
          env,
        });
        const rpc = makeRpcClient(child);
        rpc.onRequest((request) => {
          Effect.runSync(rpc.respond(request.id, declineFor(request)));
        });
        const turn = watchTurn(rpc, loginCommand);

        yield* Effect.gen(function* () {
          yield* initialize(rpc);
          const opened = openedFrom(
            yield* call(rpc, "thread/start", generateThreadParams(cwd, input), ThreadOpenResponse),
          );
          yield* call(
            rpc,
            "turn/start",
            generateTurnParams(opened, input, options.modelFacts),
            TurnStartResponse,
          );
        }).pipe(Effect.mapError((error) => fail(error.message)));

        const answer = answerOf(yield* Effect.promise(() => turn));
        return "text" in answer ? answer.text : yield* fail(answer.failure);
      }),
    );
