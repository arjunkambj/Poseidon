/**
 * The few app-server messages this connector reads, as narrow schemas.
 *
 * The CLI can print bindings for its whole protocol
 * (`codex app-server generate-ts --experimental --out <dir>`), several hundred
 * files that move with every release. They are read, never vendored: each
 * schema here names only the members the connector uses, and a struct ignores
 * the rest, so a release that adds members changes nothing and one that drops
 * a member we read fails loudly at the decode. The shapes were read off the
 * bindings of `PROTOCOL_CLI_VERSION` and the real frames of
 * `fixtures/codex/probe/`.
 *
 * Nullable members are spelled `NullOr` because the server writes `null`
 * rather than leaving them out.
 */

import * as Schema from "effect/Schema";

/**
 * The release whose bindings and recordings these schemas were read against.
 * `SkillsListResponse`'s `path` and `enabled`, like the `thread/fork` and
 * `skills/extraRoots/set` requests, were read against 0.159.2, whose
 * recordings are the only ones to use them.
 */
export const PROTOCOL_CLI_VERSION = "0.156.1";

// ── initialize ─────────────────────────────────────────────────

/** What `initialize` answers: the server's view of where it runs. */
export const InitializeResponse = Schema.Struct({
  userAgent: Schema.String,
  /** The `CODEX_HOME` the server reads its login and config from. */
  codexHome: Schema.String,
});
export type InitializeResponse = typeof InitializeResponse.Type;

// ── account/read ───────────────────────────────────────────────

/**
 * The signed-in account. Only the `type` tag and the ChatGPT login's email
 * are read; the other variants (`apiKey`, `amazonBedrock`) carry nothing that
 * names a person.
 */
export const Account = Schema.Struct({
  type: Schema.String,
  email: Schema.optional(Schema.NullOr(Schema.String)),
  planType: Schema.optional(Schema.NullOr(Schema.String)),
});
export type Account = typeof Account.Type;

export const GetAccountResponse = Schema.Struct({
  account: Schema.NullOr(Account),
  requiresOpenaiAuth: Schema.Boolean,
});
export type GetAccountResponse = typeof GetAccountResponse.Type;

// ── model/list ─────────────────────────────────────────────────

/** One rung of a model's reasoning ladder. The effort is an open string. */
export const ReasoningEffortOption = Schema.Struct({
  reasoningEffort: Schema.String,
});

/** One row of the model catalogue. */
export const CodexModel = Schema.Struct({
  /** The id `thread/start` and `turn/start` take. */
  model: Schema.String,
  displayName: Schema.String,
  /** The catalogue's one-line tagline; optional, so an app-server without it still decodes. */
  description: Schema.optional(Schema.String),
  hidden: Schema.Boolean,
  supportedReasoningEfforts: Schema.Array(ReasoningEffortOption),
  defaultReasoningEffort: Schema.String,
  /** `text`, `image`, `audio`. */
  inputModalities: Schema.Array(Schema.String),
  isDefault: Schema.Boolean,
});
export type CodexModel = typeof CodexModel.Type;

export const ModelListResponse = Schema.Struct({
  data: Schema.Array(CodexModel),
  /** Pass to the next `model/list` to continue; null on the last page. */
  nextCursor: Schema.NullOr(Schema.String),
});
export type ModelListResponse = typeof ModelListResponse.Type;

// ── thread/start, thread/resume, turn/start ────────────────────

/**
 * What `thread/start`, `thread/resume` and `thread/fork` answer: the thread,
 * and what it runs on.
 */
export const ThreadOpenResponse = Schema.Struct({
  thread: Schema.Struct({
    /** The id `thread/resume` and every turn name the thread by. */
    id: Schema.String,
  }),
  /** The model the thread resolved to — the CLI's default when none was named. */
  model: Schema.String,
  /** The effort the thread resolved to; null when the CLI names none. */
  reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ThreadOpenResponse = typeof ThreadOpenResponse.Type;

/** What `turn/start` answers: the turn the CLI opened, whose id `turn/interrupt` takes. */
export const TurnStartResponse = Schema.Struct({
  turn: Schema.Struct({ id: Schema.String }),
});
export type TurnStartResponse = typeof TurnStartResponse.Type;

// ── skills/list ────────────────────────────────────────────────

/**
 * What `skills/list` answers: per working directory, the skills the CLI
 * loads there, each with its `SKILL.md`, which a `skill` input names.
 */
export const SkillsListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      skills: Schema.Array(
        Schema.Struct({ name: Schema.String, path: Schema.String, enabled: Schema.Boolean }),
      ),
    }),
  ),
});
export type SkillsListResponse = typeof SkillsListResponse.Type;
