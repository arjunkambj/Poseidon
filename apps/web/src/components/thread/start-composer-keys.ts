/**
 * The start composer's textarea keys — the same as a thread's composer
 * (`@/components/composer/composer-keys`): an open menu with rows takes Enter
 * and the arrows, Escape closes it, and Enter otherwise sends. Chorded Enter
 * the keymap answers (`composer.queue`, `composer.startInBackground`) is left
 * to the keymap.
 */

import type * as React from "react";

import { composerEnter, keymapChord, menuMove } from "@/components/composer/composer-keys";
import type { ComposerTriggerState } from "@/components/composer/use-composer-trigger";
import type { MentionMenus } from "@/components/composer/use-mention-menus";

export const startComposerKeyDown =
  ({
    menus,
    triggers,
    keymapAnswers,
    onSend,
  }: {
    readonly menus: MentionMenus;
    readonly triggers: ComposerTriggerState;
    readonly keymapAnswers: (event: KeyboardEvent) => boolean;
    readonly onSend: () => void;
  }) =>
  (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const moved = menus.open
      ? menuMove(event.key, event.shiftKey, triggers.activeIndex, menus.itemCount)
      : null;
    if (moved !== null || (menus.open && event.key === "Escape")) {
      event.preventDefault();
      if (moved === null) {
        triggers.close();
      } else {
        triggers.setActiveIndex(moved);
      }
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    const action = composerEnter({
      triggerOpen: menus.open,
      menuItemCount: menus.itemCount,
      shiftKey: event.shiftKey,
      keymapChord: keymapChord(event, () => keymapAnswers(event.nativeEvent)),
      composing: event.nativeEvent.isComposing,
    });
    if (action === "insert" || action === "keymap") {
      return;
    }
    event.preventDefault();
    if (action === "pick") {
      menus.pickAt(Math.min(triggers.activeIndex, menus.itemCount - 1));
      return;
    }
    triggers.close();
    onSend();
  };
