/**
 * `dock.agents`: opens the dock on the Agents tab, or closes the dock when it
 * already shows it (`dockTabTarget`). The Agents tab is a thread's, so only the
 * thread view mounts this — the New task page leaves the command unanswered,
 * and the palette does not offer it there. It has no default chord.
 */

import { useKeybindingCommand } from "@/lib/shortcuts";

import { dockTabTarget, type DockPane, type DockTab } from "./dock-toggle";

export function AgentsTabShortcut({
  dockTab,
  onShow,
}: {
  readonly dockTab: DockPane | undefined;
  readonly onShow: (tab: DockTab | null) => void;
}) {
  useKeybindingCommand("dock.agents", () => onShow(dockTabTarget(dockTab, "agents")));
  return null;
}
