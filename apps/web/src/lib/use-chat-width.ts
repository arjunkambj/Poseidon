/**
 * The chat width setting, read from and written to the settings document. The
 * width is `DEFAULT_CHAT_WIDTH` until the document loads, which is what a
 * fresh install and an older row decode to anyway, so nothing jumps.
 * `loaded` says whether it came from the document: the cycle command waits for
 * it, so it never steps from the default over a stored width.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { type ChatWidth, DEFAULT_CHAT_WIDTH } from "@poseidon/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { useAppAtoms } from "@/lib/app-runtime";
import { type ChatWidthClasses, chatWidthClasses } from "@/lib/chat-width";

export function useChatWidth(): {
  readonly width: ChatWidth;
  readonly loaded: boolean;
  readonly classes: ChatWidthClasses;
  readonly setWidth: (next: ChatWidth) => void;
} {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });

  const stored = AsyncResult.isSuccess(result) ? result.value?.chatWidth : undefined;
  const width = stored ?? DEFAULT_CHAT_WIDTH;
  const setWidth = React.useCallback(
    (next: ChatWidth) => updateSettings({ chatWidth: next }),
    [updateSettings],
  );

  return { width, loaded: stored !== undefined, classes: chatWidthClasses(width), setWidth };
}
