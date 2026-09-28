/**
 * The session reference the engine persists for a Codex thread.
 *
 * The CLI keeps each thread in its own rollout under `CODEX_HOME`, named by
 * the thread id `thread/start` answered with, and `thread/resume` takes that
 * id back. So the id is the whole of what a restart needs. `cwd` is kept
 * beside it because the thread's working directory is part of how it was
 * started, and a resume states it again.
 */

export interface CodexSessionRef {
  readonly threadId: string;
  readonly cwd: string;
}

/** The CLI's thread ids are UUIDs (v7 today); anything else is not one of its ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The reference, if `raw` is one. Anything else — a ref from another
 * connector, an older shape, an id that is not a UUID — is `undefined`, and
 * the session starts fresh and says so rather than handing the CLI an id it
 * will refuse.
 */
export const parseSessionRef = (raw: unknown): CodexSessionRef | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as { threadId?: unknown; cwd?: unknown };
  if (typeof record.threadId !== "string" || !UUID.test(record.threadId)) return undefined;
  if (typeof record.cwd !== "string" || record.cwd === "") return undefined;
  return { threadId: record.threadId, cwd: record.cwd };
};
