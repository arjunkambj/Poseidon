/**
 * Whether the desktop app is holding the machine awake right now, for the
 * Notifications page's status line. The attention coordinator writes it each
 * time it asks the shell to hold or release; `null` means there is no shell to
 * ask (a plain browser).
 */
import * as Atom from "effect/unstable/reactivity/Atom";

// `keepAlive`: written by the coordinator, read by a settings page that
// mounts and unmounts; a dropped atom would come back as the initial value.
export const keepAwakeHoldingAtom = Atom.keepAlive(Atom.make<boolean | null>(null));

/**
 * The Notifications page's line under the keep-awake switch. With the switch
 * off the shell is never asked to hold, so "nothing is running" would be a
 * guess; before the coordinator has asked the shell anything, the desktop app
 * is not holding.
 */
export const keepAwakeNote = (
  desktop: boolean,
  enabled: boolean,
  holding: boolean | null,
): string => {
  if (!desktop) return "Only in the desktop app";
  if (!enabled) return "Not holding: turned off";
  return holding === true ? "Holding: an agent is running" : "Not holding: nothing is running";
};
