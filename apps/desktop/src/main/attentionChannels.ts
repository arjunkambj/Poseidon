/**
 * The attention seam's channel names and payload shape, with no imports, so
 * the sandboxed preload (`../preload/bridge.ts`) can bundle them. The parsers
 * and the keep-awake holder are in `./attention.ts`.
 */

/** renderer → main: post a system notification for a thread. */
export const ATTENTION_NOTIFY_CHANNEL = "poseidon:attention-notify";
/** renderer → main: the dock/taskbar badge count (0 clears it). */
export const ATTENTION_BADGE_CHANNEL = "poseidon:attention-badge";
/** renderer → main: one short system beep. */
export const ATTENTION_BEEP_CHANNEL = "poseidon:attention-beep";
/** renderer → main: hold or release the power-save blocker; answers whether held. */
export const ATTENTION_KEEP_AWAKE_CHANNEL = "poseidon:attention-keep-awake";
/** renderer → main: how many threads are running or waiting on the user. */
export const ATTENTION_BUSY_CHANNEL = "poseidon:attention-busy";
/** main → renderer: a notification was clicked; open this thread. */
export const OPEN_THREAD_CHANNEL = "poseidon:open-thread";
/** main → renderer: a quit is held; ask the user to confirm it. */
export const QUIT_REQUEST_CHANNEL = "poseidon:quit-request";
/** renderer → main: the user's answer to a held quit. */
export const QUIT_ANSWER_CHANNEL = "poseidon:quit-answer";

/** A system notification for one thread. */
export interface AttentionNotice {
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
}
