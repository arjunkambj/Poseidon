/**
 * The browser host: every pane tab of every thread, rendered once, above the
 * routes (`routes/__root.tsx`).
 *
 * A pane tab is an Electron `<webview>`, and its guest lives exactly as long
 * as the element stays where it is in the DOM. Rendering it inside the dock
 * meant closing the dock, switching dock tab or thread, or visiting
 * /settings (a different layout) destroyed it — the agent's pinned tab went
 * `tab_gone` mid-task, and a `display: none` wrapper left it unable to click
 * or screenshot. So the webviews live here instead, in creation order (a
 * list that only appends and removes, so React never moves one), and are
 * placed by CSS alone:
 *
 * - the selected tab of the thread whose pane is on screen is laid over the
 *   pane's slot (`BrowserSlot`, `data-browser-slot`);
 * - every other tab keeps the pane's last size, inside the viewport,
 *   transparent, click-through and beneath the app (`./host-geometry`).
 *
 * Desktop only: a plain browser has no preload bridge and no webview tag, and
 * the pane renders the owned-Chromium frame stream there instead.
 */
import * as React from "react";

import {
  patchTab,
  selectedTab,
  tabsInCreationOrder,
  useBrowserSlot,
  useBrowserTabs,
  useSetBrowserTabs,
  type TabPatch,
} from "@/state/browser-tabs";
import { useConnectionState, useLoadedThreadList } from "@/state/hooks";

import { AgentCursor, useAgentPointers } from "./agent-cursor";
import { placeTab } from "./host-geometry";
import { TabWebview } from "./tab-webview";
import { useGuestKeys } from "./use-guest-keys";
import { useHistoryRecorder } from "./use-history-recorder";
import {
  useGuestInput,
  useLocationSync,
  useTabRequests,
  useThreadTeardown,
} from "./use-host-bridge";
import { useElementRect, useLastPaneRect, useViewport } from "./use-host-geometry";
import { usePartitionSweep } from "./use-partition-sweep";

type PaneBridge = NonNullable<NonNullable<Window["poseidon"]>["browserPane"]>;

export function BrowserHost() {
  const bridge = typeof window === "undefined" ? undefined : window.poseidon?.browserPane;
  if (bridge?.serveTabs === undefined) return null;
  return <InAppBrowserHost bridge={bridge} />;
}

function InAppBrowserHost({ bridge }: { readonly bridge: PaneBridge }) {
  const state = useBrowserTabs();
  const setTabs = useSetBrowserTabs();
  const threads = useLoadedThreadList();
  const connected = useConnectionState().status === "connected";

  useTabRequests(bridge, state, threads, setTabs);
  useGuestInput(bridge);
  useLocationSync(state);
  useThreadTeardown(bridge, state, threads, connected, setTabs);
  usePartitionSweep(bridge, threads, connected);
  useGuestKeys(bridge, state);
  useHistoryRecorder(state, threads);
  const pointers = useAgentPointers(bridge);

  const slot = useBrowserSlot();
  const slotRect = useElementRect(slot?.element ?? null);
  const lastPane = useLastPaneRect(slotRect);
  const viewport = useViewport();

  const onPatch = React.useCallback(
    (threadId: string, tabId: string, patch: TabPatch) =>
      setTabs((current) => patchTab(current, threadId, tabId, patch)),
    [setTabs],
  );

  return (
    <div data-browser-host="">
      {tabsInCreationOrder(state).map(({ threadId, tab }) => {
        const placement = placeTab(
          { threadId, selected: selectedTab(state[threadId])?.tabId === tab.tabId },
          slot === null ? null : { threadId: slot.threadId, rect: slotRect },
          lastPane,
          viewport,
        );
        const mark = tab.wcId === null ? undefined : pointers.get(tab.wcId);
        return (
          <React.Fragment key={tab.tabId}>
            <TabWebview
              threadId={threadId}
              tab={tab}
              rect={placement.rect}
              visible={placement.visible}
              onPatch={onPatch}
            />
            {placement.visible && mark !== undefined ? (
              <AgentCursor mark={mark} box={placement.rect} zoomLevel={tab.zoomLevel} />
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}
