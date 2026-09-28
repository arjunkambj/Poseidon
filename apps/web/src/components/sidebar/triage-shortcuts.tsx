/**
 * The sidebar's triage keys, which work from any route — mounted once by
 * `AppShortcuts`.
 *
 * - `sidebar.undo` undoes the latest sidebar action (`./sidebar-undo`). Its
 *   default chord is `Mod+Z`, bound only outside text fields, the terminal and
 *   the browser pane, so typing keeps its own undo.
 *
 * It is claimed only while it has something to act on — an entry on the
 * stack — so the palette never offers a row that does nothing.
 */

import { useSidebarUndo } from "@/components/sidebar/sidebar-undo";
import { useKeybindingCommand } from "@/lib/shortcuts";

function UndoShortcut({ undoLatest }: { readonly undoLatest: () => void }) {
  useKeybindingCommand("sidebar.undo", undoLatest);
  return null;
}

export function TriageShortcuts() {
  const { canUndo, undoLatest } = useSidebarUndo();

  return canUndo ? <UndoShortcut undoLatest={undoLatest} /> : null;
}
