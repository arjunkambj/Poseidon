/**
 * The Changes pane's view options, read from and written to the settings
 * document. Both are off until the document loads, which is what a fresh
 * install and an older row decode to anyway, so nothing jumps.
 *
 * A patch replaces the whole `diffView` object, so the setter merges one
 * option into the rest before it writes.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_DIFF_VIEW_SETTINGS, type DiffViewSettings } from "@poseidon/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { useAppAtoms } from "@/lib/app-runtime";

export function useDiffView(): readonly [
  DiffViewSettings,
  (next: Partial<DiffViewSettings>) => void,
] {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });

  const stored = AsyncResult.isSuccess(result) ? result.value?.diffView : undefined;
  const diffView = stored ?? DEFAULT_DIFF_VIEW_SETTINGS;
  const setDiffView = React.useCallback(
    (next: Partial<DiffViewSettings>) => updateSettings({ diffView: { ...diffView, ...next } }),
    [updateSettings, diffView],
  );
  return [diffView, setDiffView] as const;
}
