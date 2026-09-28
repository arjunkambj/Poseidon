import { describe, expect, it } from "vitest";

import { makeThreadId } from "@poseidon/contracts/ids";
import type { BrowserState } from "@poseidon/contracts/rpc";

import { idleActivity, type ThreadAgentActivity } from "@/state/browser-activity";
import type { BrowserTab, ThreadTabs } from "@/state/browser-tabs";

import {
  agentCalling,
  agentUsingBrowser,
  leaveThread,
  noteUserDockChange,
  observeAgentUse,
  shouldAutoOpen,
  showAgentIndicator,
} from "./auto-open";

const state = (activeTool: string | null | undefined): BrowserState => ({
  threadId: makeThreadId(),
  status: "ready",
  mode: "in-app",
  url: null,
  title: null,
  frame: null,
  ...(activeTool === undefined ? {} : { activeTool }),
});

const tab = (openedBy: BrowserTab["openedBy"]): BrowserTab => ({
  tabId: `tab-${openedBy}`,
  seq: 1,
  initialUrl: "about:blank",
  wcId: 7,
  url: "about:blank",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  favicon: null,
  zoomLevel: 0,
  openedBy,
});

const tabs = (...list: ReadonlyArray<BrowserTab>): ThreadTabs => ({
  tabs: list,
  selected: list[0]?.tabId ?? null,
});

/**
 * One thread's timeline, as the thread view sees it: agent observations and
 * the user's dock moves, in order. Returns how often the pane auto-opened.
 * The thread starts on screen with the agent idle, unless `from` says what
 * the window remembered before the first step.
 */
type Step =
  /** `null`: the thread's browser state has not arrived yet. */
  | { readonly agent: boolean | null }
  /** The thread leaves the screen. */
  | { readonly leave: true }
  | { readonly user: string | undefined }
  | { readonly dock: string | undefined };

const onScreen: ThreadAgentActivity = { ...idleActivity, seen: true };

const run = (
  setting: boolean,
  initialDock: string | undefined,
  steps: ReadonlyArray<Step>,
  from: ThreadAgentActivity = onScreen,
) => {
  let activity: ThreadAgentActivity = from;
  let dockTab = initialDock;
  let opens = 0;
  for (const step of steps) {
    if ("agent" in step) {
      const observed = observeAgentUse(activity, step.agent);
      activity = observed.activity;
      if (
        shouldAutoOpen({
          setting,
          dockTab,
          closedByUserWhileAgentActive: activity.closedByUser,
          agentJustStarted: observed.agentJustStarted,
        })
      ) {
        opens += 1;
        dockTab = "browser";
      }
    } else if ("leave" in step) {
      activity = leaveThread(activity);
    } else if ("user" in step) {
      activity = noteUserDockChange(activity, dockTab, step.user);
      dockTab = step.user;
    } else {
      // A move that is not the user's choice (e.g. a route restore).
      dockTab = step.dock;
    }
  }
  return { opens, dockTab, activity };
};

describe("shouldAutoOpen", () => {
  it("never opens with the setting off, its default", () => {
    const result = run(false, undefined, [
      { agent: true },
      { agent: false },
      { agent: true },
      { agent: true },
    ]);
    expect(result.opens).toBe(0);
    expect(result.dockTab).toBeUndefined();
  });

  it("opens once per agent activity with the setting on", () => {
    const result = run(true, undefined, [{ agent: true }, { agent: true }, { agent: true }]);
    expect(result.opens).toBe(1);
    expect(result.dockTab).toBe("browser");
  });

  it("opens over another dock tab, but not when the pane already shows", () => {
    expect(run(true, "changes", [{ agent: true }]).opens).toBe(1);
    expect(run(true, "browser", [{ agent: true }]).opens).toBe(0);
  });

  it("never reopens a pane the user closed while the agent was active", () => {
    const result = run(true, undefined, [
      { agent: true },
      { user: undefined },
      { agent: true },
      // The activity ends and a new one begins: still the user's "not now".
      { agent: false },
      { agent: true },
    ]);
    expect(result.opens).toBe(1);
    expect(result.dockTab).toBeUndefined();
    expect(result.activity.closedByUser).toBe(true);
  });

  it("counts leaving the pane for another dock tab as closing it", () => {
    const result = run(true, undefined, [
      { agent: true },
      { user: "changes" },
      { agent: false },
      { agent: true },
    ]);
    expect(result.opens).toBe(1);
    expect(result.dockTab).toBe("changes");
  });

  it("lets the user's own reopen clear the refusal", () => {
    const result = run(true, undefined, [
      { agent: true },
      { user: undefined },
      { user: "browser" },
      { user: undefined },
      { agent: false },
    ]);
    // Closed again while active: refused again.
    expect(result.activity.closedByUser).toBe(true);
    const reopened = run(true, undefined, [
      { agent: true },
      { user: undefined },
      { agent: false },
      { user: "browser" },
      { user: undefined },
      { agent: true },
    ]);
    // Closed while the agent was idle: not a refusal, so the next activity opens.
    expect(reopened.opens).toBe(2);
  });

  it("ignores a close while the agent is idle", () => {
    const result = run(true, "browser", [{ user: undefined }, { agent: true }]);
    expect(result.opens).toBe(1);
  });

  it("opens again for a new activity when the user never closed it", () => {
    const result = run(true, undefined, [
      { agent: true },
      { dock: undefined },
      { agent: false },
      { agent: true },
    ]);
    expect(result.opens).toBe(2);
  });
});

describe("agentUsingBrowser", () => {
  it("is true while a browser call runs", () => {
    expect(agentUsingBrowser(state("browser_click"), tabs())).toBe(true);
  });

  it("is false once the call settles, with no agent tab", () => {
    expect(agentUsingBrowser(state(null), tabs())).toBe(false);
    expect(agentUsingBrowser(state(undefined), tabs())).toBe(false);
    expect(agentUsingBrowser(null, tabs())).toBe(false);
  });

  it("stays true while a tab the agent opened is still open", () => {
    expect(agentUsingBrowser(state(null), tabs(tab("agent")))).toBe(true);
    expect(agentUsingBrowser(state(null), tabs(tab("human"), tab("popup")))).toBe(false);
  });
});

describe("arriving at a thread", () => {
  it("never opens the pane for an activity that began while the thread was off screen", () => {
    // Its agent opened a tab while the user was elsewhere; the thread's record
    // was never observed.
    const result = run(true, undefined, [{ agent: true }, { agent: true }], idleActivity);
    expect(result.opens).toBe(0);
    expect(result.activity).toMatchObject({ seen: true, active: true });
  });

  it("waits for the browser state before taking the baseline, so a call in flight opens nothing", () => {
    // The state atom starts empty; the server's snapshot then shows a call running.
    const result = run(true, undefined, [{ agent: null }, { agent: true }], idleActivity);
    expect(result.opens).toBe(0);
    expect(result.activity).toMatchObject({ seen: true, active: true });
  });

  it("takes a new baseline on every visit, so coming back mid-call opens nothing", () => {
    const result = run(
      true,
      undefined,
      [
        { agent: null },
        { agent: false },
        { leave: true },
        // Back on screen: empty until the snapshot lands, which shows a call running.
        { agent: null },
        { agent: true },
      ],
      idleActivity,
    );
    expect(result.opens).toBe(0);
  });

  it("keeps the user's refusal across visits", () => {
    const refused: ThreadAgentActivity = { active: true, closedByUser: true, seen: true };
    expect(leaveThread(refused)).toEqual({ active: true, closedByUser: true, seen: false });
    expect(leaveThread(idleActivity)).toBe(idleActivity);
  });

  it("opens for the next activity that starts while the thread is on screen", () => {
    const result = run(
      true,
      undefined,
      [{ agent: true }, { agent: false }, { agent: true }],
      idleActivity,
    );
    expect(result.opens).toBe(1);
  });
});

describe("agentCalling", () => {
  it("is a call in flight only, never an agent tab left open", () => {
    expect(agentCalling(state("browser_click"))).toBe(true);
    expect(agentCalling(state(null))).toBe(false);
    expect(agentCalling(state(""))).toBe(false);
    expect(agentCalling(null)).toBe(false);
    // The tab keeps the chip (and the activity), but not the "using" claim.
    expect(agentUsingBrowser(state(null), tabs(tab("agent")))).toBe(true);
  });
});

describe("showAgentIndicator", () => {
  it("shows while the agent uses the browser and the pane is not on screen", () => {
    expect(showAgentIndicator(true, undefined)).toBe(true);
    expect(showAgentIndicator(true, "changes")).toBe(true);
    expect(showAgentIndicator(true, "browser")).toBe(false);
    expect(showAgentIndicator(false, undefined)).toBe(false);
  });
});

describe("observeAgentUse", () => {
  it("reports the start of an activity once", () => {
    const first = observeAgentUse(onScreen, true);
    expect(first.agentJustStarted).toBe(true);
    const second = observeAgentUse(first.activity, true);
    expect(second.agentJustStarted).toBe(false);
    // Unchanged records keep their identity, so the atom does not churn.
    expect(second.activity).toBe(first.activity);
  });

  it("does not observe before the browser state arrives", () => {
    const pending = observeAgentUse(idleActivity, null);
    expect(pending).toEqual({ activity: idleActivity, agentJustStarted: false });
    expect(observeAgentUse(onScreen, null).activity).toBe(onScreen);
  });
});
