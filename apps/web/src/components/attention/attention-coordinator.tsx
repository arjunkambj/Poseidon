/**
 * Tells the user when a thread they are not watching finishes, fails or
 * starts needing them, and keeps the shell's attention state in step with
 * the thread list. Renders nothing; mounted once at the root, beside
 * `AppShortcuts`.
 *
 * - Alerts: each thread-list update is diffed against the last one
 *   (`transitions`, @/lib/attention). The first loaded list only seeds that
 *   baseline and the baseline outlives a reconnect — the list reads `null`
 *   while loading and that is skipped, not taken as "no threads" — so a
 *   replayed snapshot never alerts twice. An enabled event becomes a system
 *   notification when the window is unfocused or hidden, a toast with an Open
 *   action for another thread in a focused window, and nothing for the thread
 *   on screen. With sound on, one beep per batch.
 * - The Dock badge counts the threads that need you, and clears on unmount.
 * - Keep-awake holds while any thread runs, and the answer lands in
 *   `keepAwakeHoldingAtom` for the Notifications page.
 * - The busy count (running or waiting on you) is what the shell's quit guard
 *   asks about.
 * - A notification click opens its thread.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@poseidon/contracts/ids";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from "@poseidon/contracts/settings";
import { cn } from "@poseidon/ui/lib/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { keepAwakeHoldingAtom } from "@/components/attention/keep-awake-state";
import { useAppAtoms } from "@/lib/app-runtime";
import {
  type AttentionEvent,
  type Snapshot,
  anyRunning,
  busyThreads,
  eventEnabled,
  eventMark,
  needsYouCount,
  shouldAlert,
  snapshotOf,
  transitions,
} from "@/lib/attention";
import {
  beep,
  notify,
  onOpenThread,
  setBadge,
  setBusy,
  setKeepAwake,
} from "@/lib/desktop-attention";
import { useLoadedThreadList } from "@/state/hooks";

const windowFocused = (): boolean => document.visibilityState === "visible" && document.hasFocus();

function useNotificationSettings(): NotificationSettings {
  const result = useAtomValue(useAppAtoms().settingsAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value?.notifications ?? DEFAULT_NOTIFICATION_SETTINGS)
    : DEFAULT_NOTIFICATION_SETTINGS;
}

function showToast(event: AttentionEvent, open: (threadId: string) => void) {
  const mark = eventMark(event);
  const Icon = mark.icon;
  toast(event.title, {
    icon: <Icon variant="bold" className={cn("size-4", mark.tone)} />,
    description: mark.label,
    action: { label: "Open", onClick: () => open(event.threadId) },
  });
}

/** Alerts for each new transition in the thread list. */
function useTransitionAlerts(
  list: ReturnType<typeof useLoadedThreadList>,
  settings: NotificationSettings,
  openThreadId: string | null,
  open: (threadId: string) => void,
) {
  // Never reset: a reconnect's replay diffs against the last list seen.
  const baseline = React.useRef<Snapshot | null>(null);

  const alert = React.useEffectEvent((events: ReadonlyArray<AttentionEvent>) => {
    const focused = windowFocused();
    let sounded = false;
    for (const event of events) {
      if (!eventEnabled(event.kind, settings)) continue;
      const channel = shouldAlert(event, { openThreadId, focused });
      if (channel === "none") continue;
      sounded = true;
      if (channel === "toast") {
        showToast(event, open);
      } else {
        notify({ threadId: event.threadId, title: event.title, body: eventMark(event).label });
      }
    }
    if (sounded && settings.sound) beep();
  });

  React.useEffect(() => {
    if (list === null) return;
    const events = transitions(baseline.current, list);
    baseline.current = snapshotOf(list);
    if (events.length > 0) alert(events);
  }, [list]);
}

/** The Dock badge, keep-awake and the quit guard's busy count. */
function useShellState(
  list: ReturnType<typeof useLoadedThreadList>,
  settings: NotificationSettings,
) {
  const setHolding = useAtomSet(keepAwakeHoldingAtom);
  const threads = list ?? [];
  const badge = settings.dockBadge ? needsYouCount(threads) : 0;
  const hold = settings.keepAwake && anyRunning(threads);
  const busy = busyThreads(threads).length;

  React.useEffect(() => {
    setBadge(badge);
  }, [badge]);
  React.useEffect(() => () => setBadge(0), []);

  React.useEffect(() => {
    let current = true;
    void setKeepAwake(hold).then((holding) => {
      if (current) setHolding(holding);
    });
    return () => {
      current = false;
    };
  }, [hold, setHolding]);
  React.useEffect(() => () => void setKeepAwake(false), []);

  React.useEffect(() => {
    setBusy(busy);
  }, [busy]);
  React.useEffect(() => () => setBusy(0), []);
}

export function AttentionCoordinator() {
  const navigate = useNavigate();
  const list = useLoadedThreadList();
  const settings = useNotificationSettings();
  const openRoute = useMatchRoute()({ to: "/t/$threadId" });
  const openThreadId = openRoute === false ? null : openRoute.threadId;

  // A notification click hands back the id this coordinator posted.
  const open = React.useCallback(
    (threadId: string) =>
      void navigate({ to: "/t/$threadId", params: { threadId: threadId as ThreadId } }),
    [navigate],
  );

  useTransitionAlerts(list, settings, openThreadId, open);
  useShellState(list, settings);

  React.useEffect(() => onOpenThread(open), [open]);

  return null;
}
