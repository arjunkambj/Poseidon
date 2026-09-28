/**
 * The "Open in" hooks the header control and the file menus share: which
 * detected app is the favourite, remembering a new one, and an open that
 * toasts the server's refusal.
 *
 * The favourite is read from the settings document's `preferredEditor`
 * (`./favourite` decides what an unset, unknown or uninstalled id falls back
 * to) and written back through the same settings patch every other setting
 * uses, so a choice survives a reload and reaches every window.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { OpenInInput } from "@poseidon/client-runtime/editors";
import type { DetectedEditor } from "@poseidon/contracts/editors";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";

import { useOpenIn } from "./editor-atoms";
import { pickFavourite } from "./favourite";

/** The favourite among `editors`, and a way to make another one the favourite. */
export function useFavouriteEditor(editors: ReadonlyArray<DetectedEditor>): {
  readonly favourite: DetectedEditor | null;
  readonly choose: (editor: DetectedEditor) => void;
} {
  const atoms = useAppAtoms();
  const settings = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });
  const preferred = AsyncResult.isSuccess(settings) ? settings.value?.preferredEditor : undefined;
  const favourite = pickFavourite(editors, preferred);

  const choose = React.useCallback(
    (editor: DetectedEditor) => {
      // Finder and Terminal are opened from the menu but never become the
      // button's main half.
      if (editor.kind !== "editor" || editor.id === preferred) return;
      updateSettings({ preferredEditor: editor.id });
    },
    [preferred, updateSettings],
  );

  return { favourite, choose };
}

/** `editors.open` for `editor`, with a toast carrying the server's message when it refuses. */
export function useOpenInWithToast(): (
  editor: DetectedEditor,
  input: Omit<OpenInInput, "editor">,
) => Promise<boolean> {
  const openIn = useOpenIn();
  return React.useCallback(
    async (editor, input) => {
      const exit = await openIn({ ...input, editor: editor.id });
      if (Exit.isSuccess(exit)) return true;
      toast.error(describeExitError(exit, `Could not open ${editor.label}`));
      return false;
    },
    [openIn],
  );
}
