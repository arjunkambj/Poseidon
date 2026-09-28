/**
 * What picking a `/` menu row does. Levels and inserts edit the draft; the
 * clear-draft row empties it; `/compact` and the settings rows drop the typed
 * token and start a compaction or dispatch a `thread.settings.update`. Kept
 * out of `composer.tsx` so the component stays a layout of its hooks.
 */

import { useAtomSet } from "@effect/atom-react";
import { makeCommandId, type ThreadId } from "@poseidon/contracts/ids";
import {
  replaceComposerTrigger,
  type ComposerTrigger,
} from "@poseidon/client-runtime/composerTrigger";
import type * as React from "react";

import { compactRefusal } from "@/components/composer/compact-now";
import type { SlashLevel, SlashMenuItem } from "@/components/composer/slash-menu";
import type { CompactNow } from "@/components/composer/use-compact-now";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";

export function useSlashAction({
  threadId,
  trigger,
  text,
  running,
  compactNow,
  setText,
  setTextAndCaret,
  setSlashLevel,
  closeMenu,
  clearDraft,
  setError,
}: {
  readonly threadId: ThreadId;
  readonly trigger: ComposerTrigger | null;
  readonly text: string;
  readonly running: boolean;
  readonly compactNow: CompactNow;
  readonly setText: React.Dispatch<React.SetStateAction<string>>;
  readonly setTextAndCaret: (text: string, caret: number) => void;
  readonly setSlashLevel: (level: SlashLevel) => void;
  readonly closeMenu: () => void;
  readonly clearDraft: () => void;
  readonly setError: (error: string | null) => void;
}): (item: SlashMenuItem) => void {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });

  /** Close the menu and take the typed `/…` token out of the draft. */
  const dropToken = () => {
    closeMenu();
    setText((current) =>
      trigger === null ? current : replaceComposerTrigger(current, trigger, "").text.trim(),
    );
  };

  return (item) => {
    switch (item.action.type) {
      case "level":
        setSlashLevel(item.action.level);
        return;
      case "insert":
        if (trigger !== null) {
          const next = replaceComposerTrigger(text, trigger, item.action.text);
          setTextAndCaret(next.text, next.cursor);
        }
        return;
      case "clear-draft":
        clearDraft();
        return;
      case "compact": {
        dropToken();
        const refusal = compactRefusal({ running, pending: compactNow.compacting });
        if (refusal === null) {
          compactNow.compact();
        } else {
          setError(refusal);
        }
        return;
      }
      case "settings":
        dropToken();
        void dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.settings.update",
          threadId,
          ...item.action.patch,
        }).then(
          (receipt) => setError(receiptError(receipt, "the server rejected the setting")),
          () => setError(DISPATCH_UNREACHABLE),
        );
        return;
    }
  };
}
