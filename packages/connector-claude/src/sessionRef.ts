/**
 * The session reference the engine persists for a Claude Code thread.
 *
 * The CLI keeps each conversation in its own transcript, named by a session
 * id, and resumes one with `--resume <id>` — the SDK's `resume` option. So the
 * id is the whole of what a restart needs. `cwd` is kept beside it because the
 * CLI files transcripts per project directory: a resume from another directory
 * does not find the conversation. `lastAssistantUuid` is the newest assistant
 * message the session emitted, the point the SDK's `resumeSessionAt` can
 * rewind to. `totalCostUsd` is the CLI's running cost total at the last
 * result: a resumed CLI carries the total on from its transcript, so the next
 * turn's price is measured against this (`translate/result.ts`).
 *
 * The id is the one the CLI runs on now, which is not always the one the
 * session started with: `/clear` starts the conversation over under a new id,
 * and the CLI's next `system/init` names it (`fixtures/claude/local-command/`).
 * The session follows that id (`reportedSessionId`), so a resume after a
 * `/clear` carries on the cleared conversation, not the one before it.
 */

export interface ClaudeSessionRef {
  readonly sessionId: string;
  readonly cwd: string;
  readonly lastAssistantUuid?: string;
  readonly totalCostUsd?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The reference, if `raw` is one. Anything else — a ref from another
 * connector, an older shape, a session id that is not a uuid — is `undefined`,
 * and the session starts fresh and says so rather than handing the CLI an id
 * it will refuse.
 */
export const parseSessionRef = (raw: unknown): ClaudeSessionRef | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as {
    sessionId?: unknown;
    cwd?: unknown;
    lastAssistantUuid?: unknown;
    totalCostUsd?: unknown;
  };
  if (typeof record.sessionId !== "string" || !UUID.test(record.sessionId)) return undefined;
  if (typeof record.cwd !== "string" || record.cwd === "") return undefined;
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    ...(typeof record.lastAssistantUuid === "string" && record.lastAssistantUuid !== ""
      ? { lastAssistantUuid: record.lastAssistantUuid }
      : {}),
    ...(typeof record.totalCostUsd === "number" &&
    Number.isFinite(record.totalCostUsd) &&
    record.totalCostUsd >= 0
      ? { totalCostUsd: record.totalCostUsd }
      : {}),
  };
};

/**
 * The session id a `system/init` names — the CLI says it at the start of every
 * turn — or undefined for any other message, or one that names none.
 */
export const reportedSessionId = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { type?: unknown; subtype?: unknown; session_id?: unknown };
  if (record.type !== "system" || record.subtype !== "init") return undefined;
  return typeof record.session_id === "string" && UUID.test(record.session_id)
    ? record.session_id
    : undefined;
};
