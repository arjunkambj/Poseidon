/**
 * The pane's two ways to bring the page into the conversation, beside the
 * address bar: pick an element (its CSS path, text and HTML go into the
 * thread's draft) and screenshot the tab (a PNG attached to the draft). Both
 * land in the composer's per-thread draft (`@/state/ui`), so the person
 * reviews and sends them; neither talks to the agent on its own.
 */
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { toast } from "sonner";

import { rejectionMessage, triageAttachments } from "@/components/composer/attachment-rules";
import { getTabView } from "@/components/browser-host/tab-views";
import type { BrowserTab } from "@/state/browser-tabs";
import { useComposerDraft } from "@/state/ui";
import { CursorClick, Scan } from "@honeyicons/react";

import {
  appendToDraft,
  CANCEL_PICK_SCRIPT,
  onNewDocument,
  parsePicked,
  pickedElementText,
  PICK_SCRIPT,
  screenshotFile,
} from "./page-to-chat";

/** Ends the picker running in a tab's page, if it still is. */
const cancelIn = (tabId: string): void =>
  void getTabView(tabId)
    ?.executeJavaScript(CANCEL_PICK_SCRIPT)
    .catch(() => undefined);

export interface PageActionsProps {
  readonly threadId: string;
  readonly tab: BrowserTab | null;
}

export function PageActions({ threadId, tab }: PageActionsProps) {
  const draft = useComposerDraft(threadId);
  const [picking, setPicking] = React.useState(false);
  const capture = window.poseidon?.browserPane?.capture;
  const ready = tab !== null && tab.wcId !== null;

  // The tab a pick runs in, and which pick is current: a pick the pane ended
  // itself may never settle (its page navigated away), so only the current
  // one's result counts.
  const pickingIn = React.useRef<string | null>(null);
  const pickToken = React.useRef(0);
  const endPick = React.useCallback(() => {
    pickToken.current += 1;
    pickingIn.current = null;
    setPicking(false);
  }, []);
  // A tab switch or close ends a pick in the old tab.
  React.useEffect(() => {
    const previous = pickingIn.current;
    if (previous !== null && previous !== tab?.tabId) {
      cancelIn(previous);
      endPick();
    }
  }, [tab?.tabId, endPick]);

  // So does a new document in the tab, which takes the picker with it. An
  // in-page navigation keeps the page and its picker, so the pick goes on.
  React.useEffect(() => {
    const tabId = pickingIn.current;
    const view = picking && tabId !== null ? getTabView(tabId) : null;
    if (view === null) return;
    return onNewDocument(view, () => {
      if (pickingIn.current === tabId) endPick();
    });
  }, [picking, endPick]);

  // And a new guest behind the tab (its renderer was replaced).
  React.useEffect(() => {
    const tabId = pickingIn.current;
    if (tabId === null) return;
    cancelIn(tabId);
    endPick();
  }, [tab?.wcId, endPick]);

  // The page's own Escape handler only hears keys while the page has focus;
  // Escape anywhere else in the window cancels too.
  React.useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      const tabId = pickingIn.current;
      if (event.key !== "Escape" || tabId === null) return;
      event.preventDefault();
      event.stopPropagation();
      cancelIn(tabId);
      endPick();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picking, endPick]);

  const pick = async () => {
    if (tab === null) return;
    const view = getTabView(tab.tabId);
    if (view === null) return;
    if (picking) {
      cancelIn(tab.tabId);
      endPick();
      return;
    }
    const token = ++pickToken.current;
    setPicking(true);
    pickingIn.current = tab.tabId;
    // The picker listens for Escape in the page, which hears keys only with focus.
    view.focus();
    try {
      const picked = parsePicked(await view.executeJavaScript(PICK_SCRIPT));
      if (picked !== null && pickToken.current === token) {
        draft.setText((current) => appendToDraft(current, pickedElementText(picked, tab.url)));
        toast.success("Added the element to your message");
      }
    } catch {
      if (pickToken.current === token) toast.error("Could not pick an element on this page");
    } finally {
      if (pickToken.current === token) endPick();
    }
  };

  const screenshot = async () => {
    if (capture === undefined || tab === null || tab.wcId === null) return;
    try {
      const file = screenshotFile(await capture(tab.wcId), tab.url, new Date());
      const triage = triageAttachments([file]);
      if (triage.accepted.length === 0) {
        toast.error(rejectionMessage(triage.rejected) ?? "Could not attach the screenshot");
        return;
      }
      draft.setFiles((current) => [...current, ...triage.accepted]);
      toast.success("Attached a screenshot to your message");
    } catch {
      toast.error("Could not take a screenshot of this page");
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={picking ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={picking ? "Stop picking" : "Pick an element"}
              aria-pressed={picking}
              disabled={!ready}
              onClick={() => void pick()}
            />
          }
        >
          <CursorClick variant="bold" />
        </TooltipTrigger>
        <TooltipContent>
          {picking ? "Click an element on the page, or press Escape" : "Pick an element for chat"}
        </TooltipContent>
      </Tooltip>
      {capture === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Screenshot to chat"
                disabled={!ready}
                onClick={() => void screenshot()}
              />
            }
          >
            <Scan variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Screenshot to chat</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
