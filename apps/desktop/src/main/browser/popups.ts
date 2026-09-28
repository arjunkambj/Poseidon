/**
 * Which `window.open` popups from a pane page become pane tabs.
 *
 * Electron ships no popup blocker, and a pane tab carries `allowpopups`, so
 * every `window.open` a page makes reaches the guest's window-open handler
 * (`../ipc.ts`) whether or not a person clicked anything. Unchecked, a hostile
 * page could loop `window.open` into a guest renderer per call and keep taking
 * the visible tab. So per thread:
 * - at most `burst` popups are admitted in any `windowMs`;
 * - no popup is admitted once the thread holds `maxTabs` pane tabs;
 * - a popup opens in the background unless its opener has focus, which is
 *   what a person clicking a link in the page (or the agent's native click,
 *   which runs with the guest focused) looks like.
 */

const POPUP_BURST = 4;
const POPUP_WINDOW_MS = 10_000;
const POPUP_MAX_TABS = 20;

export interface PopupGateOptions {
  readonly now?: () => number;
  readonly burst?: number;
  readonly windowMs?: number;
  readonly maxTabs?: number;
}

export interface PopupRequest {
  readonly threadId: string;
  /** How many pane tabs the thread holds now. */
  readonly openTabs: number;
  /** Whether the page that opened the popup has focus. */
  readonly openerFocused: boolean;
}

export type PopupDecision =
  | { readonly kind: "open"; readonly background: boolean }
  | { readonly kind: "drop"; readonly reason: string };

export interface PopupGate {
  readonly decide: (request: PopupRequest) => PopupDecision;
}

export const makePopupGate = (options: PopupGateOptions = {}): PopupGate => {
  const now = options.now ?? Date.now;
  const burst = options.burst ?? POPUP_BURST;
  const windowMs = options.windowMs ?? POPUP_WINDOW_MS;
  const maxTabs = options.maxTabs ?? POPUP_MAX_TABS;
  /** Per thread, when each recently admitted popup opened. */
  const recent = new Map<string, Array<number>>();

  return {
    decide: ({ threadId, openTabs, openerFocused }) => {
      if (openTabs >= maxTabs) {
        return { kind: "drop", reason: `the thread already has ${openTabs} browser tabs` };
      }
      const at = now();
      const times = (recent.get(threadId) ?? []).filter((time) => at - time < windowMs);
      if (times.length >= burst) {
        recent.set(threadId, times);
        return { kind: "drop", reason: `more than ${burst} popups in ${windowMs / 1000} s` };
      }
      times.push(at);
      recent.set(threadId, times);
      return { kind: "open", background: !openerFocused };
    },
  };
};
