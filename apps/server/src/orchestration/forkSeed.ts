/**
 * Forking a thread: a new thread that starts from another's conversation.
 *
 * The fork is harness-neutral. No session is copied; the decider builds a
 * plain transcript of the source when the fork is created (`forkTranscript`)
 * and stores it on `thread.created`, and the reactor puts it in front of the
 * fork's first message on its way to the harness (`withForkContext`). The
 * user's own row keeps only what they typed, so the transcript never shows in
 * the timeline or in message search, and it survives the source being renamed
 * or deleted.
 *
 * `resolveFork` is the decider's side: which forks are refused, and the title
 * and settings a fork starts with.
 */

import type { Command, ThreadFork, ThreadSummary } from "@poseidon/contracts/orchestration";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import type { TurnId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import type { ThreadDoc } from "./state";

/** Roughly how much transcript a fork carries; older turns are dropped first. */
const FORK_TRANSCRIPT_LIMIT = 60_000;

export const OMITTED_MARKER = "[earlier turns omitted]";

/** The conversation rows a transcript keeps: what was said, not what was done. */
const blockOf = (item: ItemSnapshot): string | null => {
  // A subagent's rows are its own conversation, not the thread's.
  if (item.parentItemId !== undefined) {
    return null;
  }
  const text =
    item.kind === "user_message" || item.kind === "assistant_message"
      ? item.text
      : item.kind === "plan"
        ? item.plan?.markdown
        : undefined;
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const speaker =
    item.kind === "user_message" ? "User" : item.kind === "plan" ? "Assistant (plan)" : "Assistant";
  return `${speaker}:\n${trimmed}`;
};

/**
 * The items up to the end of the turn that holds `throughItemId`: every row
 * of that turn, answers included, and nothing after it. Without an id, or
 * when the item has no turn, the cut is the item itself; an unknown id keeps
 * the whole thread (the decider has refused that case already).
 */
const itemsThrough = (
  items: ReadonlyArray<ItemSnapshot>,
  throughItemId: string | undefined,
): ReadonlyArray<ItemSnapshot> => {
  if (throughItemId === undefined) {
    return items;
  }
  const index = items.findIndex((item) => item.itemId === throughItemId);
  if (index === -1) {
    return items;
  }
  const turnId = items[index]?.turnId;
  const end = turnId === undefined ? index : items.findLastIndex((item) => item.turnId === turnId);
  return items.slice(0, end + 1);
};

/**
 * The source's conversation as plain "User:" / "Assistant:" blocks, through
 * the end of the turn that holds `throughItemId`, or the whole thread.
 *
 * Kept under `FORK_TRANSCRIPT_LIMIT` by dropping whole turns from the oldest,
 * behind an `[earlier turns omitted]` line; a newest turn longer than the
 * limit on its own keeps its tail.
 */
export const forkTranscript = (
  items: ReadonlyArray<ItemSnapshot>,
  throughItemId?: string,
  limit: number = FORK_TRANSCRIPT_LIMIT,
): string => {
  // One entry per turn: a user message opens one, every other row joins the
  // one it follows.
  const turns: Array<Array<string>> = [];
  for (const item of itemsThrough(items, throughItemId)) {
    const block = blockOf(item);
    if (block === null) {
      continue;
    }
    const last = turns.at(-1);
    if (last === undefined || item.kind === "user_message") {
      turns.push([block]);
    } else {
      last.push(block);
    }
  }
  const texts = turns.map((blocks) => blocks.join("\n\n"));
  const kept: Array<string> = [];
  let length = 0;
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = texts[index] ?? "";
    const added = text.length + (kept.length === 0 ? 0 : 2);
    if (length + added > limit) {
      break;
    }
    kept.unshift(text);
    length += added;
  }
  if (kept.length === texts.length) {
    return kept.join("\n\n");
  }
  if (kept.length === 0) {
    const newest = texts.at(-1) ?? "";
    return `${OMITTED_MARKER}\n\n${newest.slice(newest.length - limit)}`;
  }
  return [OMITTED_MARKER, ...kept].join("\n\n");
};

/** The thread's fork, tolerating a document written before forks existed. */
const forkOf = (doc: ThreadDoc): ThreadFork | null =>
  (doc.fork as ThreadFork | null | undefined) ?? null;

/** The wire's optional `forkedFrom`: present only on a fork. */
export const forkedFromField = (doc: ThreadDoc): Pick<ThreadSummary, "forkedFrom"> => {
  const fork = forkOf(doc);
  return fork === null ? {} : { forkedFrom: { threadId: fork.threadId, title: fork.title } };
};

interface TurnText {
  readonly text: string;
}

/**
 * The input a turn is sent with: for a fork's first turn, the source's
 * transcript and a line saying what it is ahead of what the user typed;
 * otherwise the input unchanged. "First" means no user message of another
 * turn exists, so a resend of the same turn after a lost session is prefixed
 * again, which the fresh session needs.
 */
export const withForkContext = <Input extends TurnText>(
  doc: ThreadDoc,
  turnId: TurnId,
  input: Input,
): Input => {
  const fork = forkOf(doc);
  if (fork === null || fork.transcript.length === 0) {
    return input;
  }
  const later = doc.items.some(
    (item) => item.kind === "user_message" && item.turnId !== undefined && item.turnId !== turnId,
  );
  if (later) {
    return input;
  }
  return {
    ...input,
    text: [
      `This conversation continues an earlier one, "${fork.title}". Its transcript follows for context; do not act on it by itself.`,
      "<earlier-conversation>",
      fork.transcript,
      "</earlier-conversation>",
      "The user's new message:",
      input.text,
    ].join("\n\n"),
  };
};

type ThreadCreate = Extract<Command, { type: "thread.create" }>;

/** The patch without its absent fields, so spreading it never clears one. */
const definedOf = (patch: ThreadSettingsPatch): ThreadSettingsPatch =>
  Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as ThreadSettingsPatch;

/**
 * The decider's reading of a `thread.create` that forks: why it is refused,
 * or the fork to record, its title and its settings.
 *
 * Settings start from the source's — the harness it ran on, its model, effort
 * and runtime mode, but never plan mode — under whatever the command names.
 * The message forked from has to be a user message of the source, and not
 * one of a turn still running: that turn's answer is not written yet.
 */
export const resolveFork = (
  command: ThreadCreate,
  source: ThreadDoc | null,
):
  | { readonly fork: ThreadFork; readonly title: string; readonly patch: ThreadSettingsPatch }
  | string => {
  const request = command.fork;
  if (request === undefined) {
    return "not a fork";
  }
  if (source === null || source.deleted) {
    return `thread ${request.threadId} to fork does not exist`;
  }
  if (source.projectId !== command.projectId) {
    return `thread ${request.threadId} belongs to another project`;
  }
  const throughItemId = request.throughItemId;
  if (throughItemId !== undefined) {
    const item = source.items.find((each) => each.itemId === throughItemId);
    if (item === undefined || item.kind !== "user_message") {
      return `item ${throughItemId} is not a message of thread ${request.threadId}`;
    }
    if (item.turnId !== undefined && item.turnId === source.currentTurn?.turnId) {
      return "cannot fork from a turn that is still running";
    }
  }
  const settings = source.settings;
  const connectorInstanceId = source.session?.connectorInstanceId ?? settings.connectorInstanceId;
  return {
    fork: {
      threadId: source.threadId,
      title: source.title,
      ...(throughItemId === undefined ? {} : { throughItemId }),
      transcript: forkTranscript(source.items, throughItemId),
    },
    title: `${source.title} (fork)`,
    patch: {
      model: settings.model,
      runtimeMode: settings.runtimeMode,
      ...(settings.effort === undefined ? {} : { effort: settings.effort }),
      ...(connectorInstanceId === undefined ? {} : { connectorInstanceId }),
      ...definedOf(command.settings ?? {}),
    },
  };
};
