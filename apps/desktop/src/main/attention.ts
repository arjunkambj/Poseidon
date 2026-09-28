/**
 * The attention seam's Electron-free pieces: the payload
 * parsers `attentionIpc.ts` runs every renderer message through, and the
 * keep-awake holder that owns at most one power-save blocker.
 *
 * The renderer decides *when* to notify, badge, beep or hold the machine
 * awake (it is the one that knows which thread is on screen); main only
 * carries it out, and only for well-formed payloads. The channel names live
 * in `./attentionChannels.ts`, which the sandboxed preload can import: this
 * module pulls in the bridge's thread-id pattern and, with it, `node:crypto`.
 */

import { BRIDGE_THREAD_ID } from "@poseidon/shared/browserBridge";

import type { AttentionNotice } from "./attentionChannels";

export {
  ATTENTION_BADGE_CHANNEL,
  ATTENTION_BEEP_CHANNEL,
  ATTENTION_BUSY_CHANNEL,
  ATTENTION_KEEP_AWAKE_CHANNEL,
  ATTENTION_NOTIFY_CHANNEL,
  OPEN_THREAD_CHANNEL,
  QUIT_ANSWER_CHANNEL,
  QUIT_REQUEST_CHANNEL,
  type AttentionNotice,
} from "./attentionChannels";

const TITLE_MAX = 120;
const BODY_MAX = 240;
/** Far above any real thread count; a runaway value never reaches the dock. */
const COUNT_MAX = 9_999;

const capped = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** A notification payload, or null for anything not shaped like one. */
export const parseNotify = (payload: unknown): AttentionNotice | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const { threadId, title, body } = payload as Record<string, unknown>;
  if (typeof threadId !== "string" || !BRIDGE_THREAD_ID.test(threadId)) return null;
  if (typeof title !== "string" || title.trim() === "") return null;
  if (body !== undefined && typeof body !== "string") return null;
  return {
    threadId,
    title: capped(title, TITLE_MAX),
    body: capped(body ?? "", BODY_MAX),
  };
};

/** A count clamped to a non-negative integer; anything else is 0. */
const parseCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(COUNT_MAX, Math.max(0, Math.floor(value)));
};

/** The badge count to show; 0 clears the badge. */
export const parseBadge = parseCount;

/** The renderer's count of running or waiting threads, for the quit guard. */
export const parseBusyCount = parseCount;

/** The part of Electron's `powerSaveBlocker` the holder uses. */
export interface PowerSaveBlocker {
  readonly start: () => number;
  readonly stop: (id: number) => void;
  readonly isStarted: (id: number) => boolean;
}

/**
 * Holds at most one blocker: `set(true)` starts one unless one is already
 * running, `set(false)` stops it; both are idempotent. Answers whether the
 * machine is being held awake after the call.
 */
export const makeKeepAwake = (blocker: PowerSaveBlocker) => {
  let id: number | null = null;
  const holding = () => id !== null && blocker.isStarted(id);
  return {
    set: (hold: boolean): boolean => {
      if (hold) {
        if (!holding()) id = blocker.start();
      } else if (id !== null) {
        if (blocker.isStarted(id)) blocker.stop(id);
        id = null;
      }
      return holding();
    },
    holding,
  };
};

/** The part of a window's `WebContents` that says its page is gone. */
export interface PageLifecycle {
  readonly once: (event: "destroyed", listener: () => void) => unknown;
  readonly on: (event: "render-process-gone", listener: () => void) => unknown;
}

/**
 * Runs `release` when the window's page goes away without saying so: the
 * window is closed (on macOS the app keeps running) or its renderer crashes.
 * The renderer clears the badge, the keep-awake hold and the busy count on
 * unmount, but a torn-down page never unmounts, so main lets go of them here;
 * the next page's coordinator sets them again.
 */
export const releaseWhenPageGone = (contents: PageLifecycle, release: () => void) => {
  contents.once("destroyed", release);
  contents.on("render-process-gone", release);
};
