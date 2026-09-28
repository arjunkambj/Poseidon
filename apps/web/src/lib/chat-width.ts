/**
 * The chat width setting, as Tailwind classes. The timeline, the composer, the
 * start screen and the harness banner all read their max width from here so
 * they stay aligned whichever width the user picks.
 *
 * Every class is a complete literal: Tailwind finds classes by scanning the
 * source, so a name built by concatenation would never be generated.
 */

import type { ChatWidth } from "@poseidon/contracts/settings";

export interface ChatWidthClasses {
  /** The timeline's scroll content, 16px wider than the column for its gutter. */
  readonly timeline: string;
  /** The composer, the start screen and the banners. */
  readonly column: string;
}

const CLASSES: Record<ChatWidth, ChatWidthClasses> = {
  comfortable: { timeline: "max-w-[700px]", column: "max-w-[684px]" },
  wide: { timeline: "max-w-[960px]", column: "max-w-[944px]" },
  full: { timeline: "max-w-none", column: "max-w-none" },
};

export const chatWidthClasses = (width: ChatWidth): ChatWidthClasses => CLASSES[width];

/** The widths in the order the toggle lists them and the cycle command steps. */
export const CHAT_WIDTHS: ReadonlyArray<{ readonly value: ChatWidth; readonly label: string }> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

/** The width after `width`, wrapping from the last back to the first. */
export const nextChatWidth = (width: ChatWidth): ChatWidth => {
  const index = CHAT_WIDTHS.findIndex((entry) => entry.value === width);
  return CHAT_WIDTHS[(index + 1) % CHAT_WIDTHS.length]!.value;
};
