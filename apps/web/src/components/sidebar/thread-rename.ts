/**
 * Inline rename in the sidebar: which row, if any, shows its title as an input.
 *
 * One row at a time, for the whole sidebar — starting a rename on another row
 * ends the one in progress, which blurs and so cancels it anyway. The row menu
 * and a double-click on a row's title start it; `./thread-title-input` ends
 * it. The dialog behind `Mod+Alt+R` on the open thread is a separate path.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

// `keepAlive`: the row that starts a rename is not always the one that shows it
// mounted, and a dropped atom would forget the id in between.
const renamingThreadAtom = Atom.keepAlive(Atom.make<string | null>(null));

/** `[renamingId, start, stop]` — the row being renamed, and begin or end it. */
export const useRenamingThread = () => {
  const renamingId = useAtomValue(renamingThreadAtom);
  const set = useAtomSet(renamingThreadAtom);
  const start = React.useCallback((threadId: string) => set(threadId), [set]);
  const stop = React.useCallback(() => set(null), [set]);
  return [renamingId, start, stop] as const;
};

/**
 * The title to send for `draft`, trimmed — or null when there is nothing to
 * send: an empty draft keeps the old title, and an unchanged one is no rename.
 */
export const renameTarget = (current: string, draft: string): string | null => {
  const title = draft.trim();
  return title === "" || title === current ? null : title;
};
