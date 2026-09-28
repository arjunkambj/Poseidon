/**
 * Generated text: the settings that say which harness writes auxiliary text
 * (commit messages, pull-request text, thread titles) and in what style, and
 * the RPCs that ask for it.
 *
 * Kept apart from `settings.ts` and `rpc.ts` for the same reason `search.ts`
 * is: `settings.ts` embeds `GenerationSettings` and the git writing options,
 * the method names are meant to be spread into `RPC_METHODS`, and `rpc.ts`
 * lists the RPCs in `PoseidonRpcGroup` together with their handlers. Nothing
 * here names a harness: the server picks one that declares the
 * `textGeneration` capability.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { NonEmptyString } from "./base";
import { ConnectorInstanceId, ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";

// ── Settings ───────────────────────────────────────────────────

/** How hard the Writing model thinks. Ignored for a model that takes no effort. */
export const WritingEffort = Schema.Literals(["low", "medium", "high"]);
export type WritingEffort = typeof WritingEffort.Type;

/**
 * The harness and model that write generated text, always as a pair: a bare
 * model id could not say which harness to run it on.
 */
export const WritingModel = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId,
  model: NonEmptyString,
});
export type WritingModel = typeof WritingModel.Type;

/**
 * The Models page's "Generated text" section. `writingModel` null means Same
 * as the thread: the thread's own harness and model, or the routed default
 * when there is no thread. Every field is defaulted on decode, so a document
 * written before one existed still decodes.
 */
export const GenerationSettings = Schema.Struct({
  writingModel: Schema.NullOr(WritingModel).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  writingEffort: WritingEffort.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<WritingEffort>("low")),
  ),
  autoTitle: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type GenerationSettings = typeof GenerationSettings.Type;

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  writingModel: null,
  writingEffort: "low",
  autoTitle: true,
};

/**
 * Where commit and PR text takes its style from: the repository's own recent
 * subjects and agent notes, Conventional Commits, or the user's instructions.
 */
export const WritingStyle = Schema.Literals(["repository", "conventional", "custom"]);
export type WritingStyle = typeof WritingStyle.Type;

/** What the commit dialog's message starts as: today's template, or generated text. */
export const CommitDraftMode = Schema.Literals(["template", "generate"]);
export type CommitDraftMode = typeof CommitDraftMode.Type;

/** The longest custom writing instructions a settings document holds, in characters. */
export const CUSTOM_INSTRUCTIONS_MAX = 20_000;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const GENERATION_RPC_METHODS = {
  gitGenerateCommitMessage: "git.generateCommitMessage",
  gitGeneratePullRequest: "git.generatePullRequest",
  threadRegenerateTitle: "thread.regenerateTitle",
} as const;

/**
 * Said once when the chosen Writing model was switched off or is gone and the
 * text was written by Same as the thread instead. Absent when nothing fell back.
 */
const notice = Schema.optional(NonEmptyString);

/**
 * A commit message for the thread's workspace (or the project's root), written
 * from the diff of `paths` — every changed path when absent. Fails with code
 * `unavailable` when no harness can generate text.
 */
export const GitGenerateCommitMessageRpc = Rpc.make(
  GENERATION_RPC_METHODS.gitGenerateCommitMessage,
  {
    payload: Schema.Struct({
      projectId: ProjectId,
      threadId: Schema.optional(ThreadId),
      paths: Schema.optional(Schema.Array(NonEmptyString)),
    }),
    success: Schema.Struct({ subject: NonEmptyString, body: Schema.String, notice }),
    error: PoseidonRpcError,
  },
);

/**
 * A pull-request title and body, written from the branch's commits and its
 * diff against `base` — the repository's default branch when absent. Fails
 * with code `unavailable` when no harness can generate text.
 */
export const GitGeneratePullRequestRpc = Rpc.make(GENERATION_RPC_METHODS.gitGeneratePullRequest, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    base: Schema.optional(NonEmptyString),
  }),
  success: Schema.Struct({ title: NonEmptyString, body: Schema.String, notice }),
  error: PoseidonRpcError,
});

/**
 * A new title for a thread, written from the end of its conversation and
 * applied with `thread.rename` before it answers. Fails with code
 * `unavailable` when no harness can generate text.
 */
export const ThreadRegenerateTitleRpc = Rpc.make(GENERATION_RPC_METHODS.threadRegenerateTitle, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({ title: NonEmptyString, notice }),
  error: PoseidonRpcError,
});
