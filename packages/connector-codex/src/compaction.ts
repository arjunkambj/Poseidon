/**
 * Compacting on demand.
 *
 * Poseidon asks a harness to compact with a turn whose text is `/compact` —
 * what a typed `/compact` sends, and what the composer's "Compact now" sends.
 * The app-server has no slash commands in its input; compaction is a request
 * of its own, `thread/compact/start { threadId }`, answered at once with
 * nothing. The CLI then runs the compaction as a turn of its own:
 * `turn/started` names it (the only place its id appears), a
 * `contextCompaction` item opens and completes — the timeline's
 * `context_compaction` row — the thread's token count restates the context
 * now in use (`context.updated`), and `turn/completed` ends it. So a
 * `/compact` turn is sent as that request, and Poseidon's turn is the CLI's
 * compaction turn. `compaction` records it on a one-turn thread.
 */

import type { TurnInput } from "@poseidon/connector-sdk/definition";
import * as Schema from "effect/Schema";

/** The text of the turn that asks for a compaction. */
export const COMPACT_COMMAND = "/compact";

/** Whether a turn is the request to compact, not a message for the model. */
export const isCompactCommand = (turn: TurnInput): boolean => turn.text.trim() === COMPACT_COMMAND;

/** What `thread/compact/start` answers: nothing; the compaction runs as its own turn. */
export const ThreadCompactStartResponse = Schema.Struct({});
