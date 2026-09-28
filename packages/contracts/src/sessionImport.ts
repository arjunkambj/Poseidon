/**
 * Sessions a harness recorded on its own, outside Poseidon, that can be
 * brought in as threads. Each connector that can read its harness's session
 * files lists them through its `sessions` extension
 * (`@poseidon/connector-sdk/extensions`); the file formats and the harness's
 * own session reference stay inside that connector, so this is all the wire
 * ever carries about one.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";

/**
 * One session, as the list names it. `sourceId` is the harness's own id for
 * it, the key an import asks for; `cwd` is the directory it ran in, which a
 * resume must run in too. `title` is the harness's title when it keeps one,
 * else the first prompt, shortened. `startedAt` is its first record's time and
 * `updatedAt` the file's last write.
 *
 * `messageCount` counts its user and assistant messages. A list reads only
 * the head of each file, so a listing stays cheap however long the sessions
 * are; it gives the count only when the whole file fit in that head, and
 * leaves it out rather than give a short one. Reading a session always
 * counts them all.
 */
export const ImportableSession = Schema.Struct({
  sourceId: NonEmptyString,
  cwd: NonEmptyString,
  title: NonEmptyString,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  messageCount: Schema.optional(NonNegativeInt),
});
export type ImportableSession = typeof ImportableSession.Type;
