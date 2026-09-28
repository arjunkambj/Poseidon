/**
 * When the thread's browser pane shows itself, as pure functions.
 *
 * The pane is closed by default: the agent's first browser call creates the
 * thread's tab hidden, and the thread header shows "Agent is using the
 * browser — Show" instead. Only the `browser.openPaneOnAgentUse` setting
 * (off by default) opens the pane by itself, and then only under two rules:
 *
 * - **Once per agent activity.** An activity starts when the agent begins
 *   using the thread's browser — a `browser_*` call in flight, or a tab it
 *   opened — and lasts while either is true. The agent's tabs outlive its
 *   calls, so one task's many calls are one activity. Only a start seen while
 *   the thread is on screen counts: opening a thread never opens its pane.
 * - **Never over the user.** Closing the pane (or leaving it for another dock
 *   tab) while the agent is active means "not now" for that thread, until the
 *   user opens the pane again themselves.
 *
 * The dock tab is a plain string here: the tab union belongs to the dock.
 */

import type { BrowserState } from "@poseidon/contracts/rpc";

import type { ThreadAgentActivity } from "@/state/browser-activity";
import type { ThreadTabs } from "@/state/browser-tabs";

/** A `browser_*` call is running right now. */
export const agentCalling = (state: BrowserState | null): boolean =>
  typeof state?.activeTool === "string" && state.activeTool !== "";

/** A `browser_*` call is running, or the agent has a tab open in the thread. */
export const agentUsingBrowser = (state: BrowserState | null, tabs: ThreadTabs): boolean =>
  agentCalling(state) || tabs.tabs.some((tab) => tab.openedBy === "agent");

/** The indicator shows while the agent uses the browser and the pane is not on screen. */
export const showAgentIndicator = (using: boolean, dockTab: string | undefined): boolean =>
  using && dockTab !== "browser";

/**
 * A new observation of the agent: the next record, and whether an activity
 * just began. The first observation of a thread only sets the baseline: an
 * activity already under way when the thread came on screen did not start
 * now.
 */
export const observeAgentUse = (
  previous: ThreadAgentActivity,
  using: boolean,
): { readonly activity: ThreadAgentActivity; readonly agentJustStarted: boolean } => {
  if (!previous.seen) {
    return { activity: { ...previous, seen: true, active: using }, agentJustStarted: false };
  }
  return {
    activity: previous.active === using ? previous : { ...previous, active: using },
    agentJustStarted: using && !previous.active,
  };
};

/**
 * The user moved the dock from `from` to `to` (`undefined` is closed).
 * Opening the pane clears a refusal; leaving it while the agent is active
 * records one.
 */
export const noteUserDockChange = (
  previous: ThreadAgentActivity,
  from: string | undefined,
  to: string | undefined,
): ThreadAgentActivity => {
  if (to === "browser") {
    return previous.closedByUser ? { ...previous, closedByUser: false } : previous;
  }
  if (from === "browser" && previous.active && !previous.closedByUser) {
    return { ...previous, closedByUser: true };
  }
  return previous;
};

export interface AutoOpenInput {
  /** `settings.browser.openPaneOnAgentUse`. */
  readonly setting: boolean;
  /** The thread's dock tab right now; `undefined` when the dock is closed. */
  readonly dockTab: string | undefined;
  readonly closedByUserWhileAgentActive: boolean;
  /** This observation is the start of an agent activity (`observeAgentUse`). */
  readonly agentJustStarted: boolean;
}

/** Open the pane now? Only with the setting on, at the start of an activity, and not over the user. */
export const shouldAutoOpen = (input: AutoOpenInput): boolean =>
  input.setting &&
  input.agentJustStarted &&
  input.dockTab !== "browser" &&
  !input.closedByUserWhileAgentActive;
