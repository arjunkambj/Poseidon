/**
 * The harness's own slash commands, as `connectors.commands.list` answers
 * them: what the composer's `/` menu offers in its Harness group. Choosing one
 * inserts `/name ` into the draft as plain text, and the harness runs it when
 * the message is sent. `rpc.ts` re-exports this, so importers may read it from
 * `@poseidon/contracts/rpc` too.
 */

import * as Schema from "effect/Schema";

import { NonEmptyString } from "./base";

/**
 * One command. `name` is written without the leading `/`; `description` and
 * `argumentHint` (`<file>`, `[instructions]`) are left out when the harness
 * gives none.
 */
export const HarnessCommand = Schema.Struct({
  name: NonEmptyString,
  description: Schema.optional(Schema.String),
  argumentHint: Schema.optional(Schema.String),
});
export type HarnessCommand = typeof HarnessCommand.Type;
