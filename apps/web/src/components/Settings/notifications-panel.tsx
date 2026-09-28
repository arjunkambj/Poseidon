/**
 * The Notifications page: which thread transitions post a system notification
 * (finished, failed, needs you), the optional sound, the Dock badge and keeping
 * the machine awake while an agent runs. In a plain browser it offers to ask
 * for notification permission, since the app never prompts on its own.
 *
 * The server merges a patch one key deep, so every change sends the whole
 * `notifications` object.
 */
import * as React from "react";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from "@poseidon/contracts/settings";
import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import { AsyncResult } from "effect/unstable/reactivity";

import { keepAwakeHoldingAtom, keepAwakeNote } from "@/components/attention/keep-awake-state";
import { useAppAtoms } from "@/lib/app-runtime";
import {
  hasDesktopAttention,
  requestWebNotifications,
  webNotificationPermission,
} from "@/lib/desktop-attention";

import { SettingsPageHeader, SettingsRow, SettingsSection } from "./settings-section";

/** The saved notification settings and a setter for one of them. */
function useNotificationSettings() {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const update = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });
  const settings = AsyncResult.isSuccess(result) ? (result.value?.notifications ?? null) : null;
  const set = (key: keyof NotificationSettings, value: boolean) =>
    update({
      notifications: { ...(settings ?? DEFAULT_NOTIFICATION_SETTINGS), [key]: value },
    });
  return { settings, set };
}

function Toggle({
  field,
  label,
  note,
}: {
  readonly field: keyof NotificationSettings;
  readonly label: string;
  readonly note?: React.ReactNode;
}) {
  const { settings, set } = useNotificationSettings();
  const id = `notifications-${field}`;
  return (
    <SettingsRow title={label} description={note} htmlFor={id}>
      <Checkbox
        id={id}
        checked={settings?.[field] ?? DEFAULT_NOTIFICATION_SETTINGS[field]}
        disabled={settings === null}
        onCheckedChange={(next) => set(field, next === true)}
      />
    </SettingsRow>
  );
}

/** In a plain browser: the permission the page has, and a way to ask for it. */
function BrowserPermission() {
  const [permission, setPermission] = React.useState(webNotificationPermission);
  if (hasDesktopAttention() || permission === null || permission === "granted") return null;
  if (permission === "denied") {
    return (
      <SettingsRow
        title="Browser notifications"
        description="This browser blocks notifications from Poseidon. Allow them in the site settings."
      />
    );
  }
  return (
    <SettingsRow
      title="Browser notifications"
      description="The browser asks once; Poseidon never prompts on its own."
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void requestWebNotifications().then(setPermission)}
      >
        Allow browser notifications
      </Button>
    </SettingsRow>
  );
}

function Alerts() {
  return (
    <SettingsSection
      title="Alerts"
      description="A system notification when a thread you are not looking at changes. Clicking it opens the thread. The thread open in a focused window never notifies."
    >
      <Toggle field="finished" label="When a thread finishes" />
      <Toggle field="failed" label="When a thread fails" />
      <Toggle field="needsYou" label="When a thread needs you (approval, question, plan ready)" />
      <Toggle field="sound" label="Play a sound" />
      <BrowserPermission />
    </SettingsSection>
  );
}

function DockBadge() {
  return (
    <SettingsSection title="Dock badge">
      <Toggle
        field="dockBadge"
        label="Show a badge on the Dock icon"
        note={hasDesktopAttention() ? "Counts the threads that need you." : "Desktop app only."}
      />
    </SettingsSection>
  );
}

function KeepAwake() {
  const holding = useAtomValue(keepAwakeHoldingAtom);
  const { settings } = useNotificationSettings();
  const enabled = settings?.keepAwake ?? DEFAULT_NOTIFICATION_SETTINGS.keepAwake;
  return (
    <SettingsSection title="Keep awake">
      <Toggle
        field="keepAwake"
        label="Keep the Mac awake while agents run"
        note={keepAwakeNote(hasDesktopAttention(), enabled, holding)}
      />
    </SettingsSection>
  );
}

export function NotificationsPanel() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Notifications"
        description="How Poseidon tells you a thread finished, failed or is waiting on you."
      />
      <Alerts />
      <DockBadge />
      <KeepAwake />
    </div>
  );
}
