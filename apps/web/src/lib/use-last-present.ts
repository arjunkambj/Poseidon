/**
 * The last value that was not `null`, for a dialog whose content comes from
 * the same state that opens it.
 *
 * A confirm opened by `confirming = kind` closes by `confirming = null`, and
 * the stock dialog keeps its popup on screen for the close animation. Read
 * straight from `confirming`, its title, body and buttons would go blank for
 * that animation; read through `useLastPresent(confirming)`, they keep the
 * action that was open until the next one replaces it.
 */

import * as React from "react";

/** `value` when it is present, else the one kept from before. */
export const lastPresent = <A>(kept: A | null, value: A | null): A | null => value ?? kept;

export function useLastPresent<A>(value: A | null): A | null {
  const [kept, setKept] = React.useState<A | null>(value);
  // Stored during render, the way React keeps a value from a previous render.
  if (value !== null && value !== kept) {
    setKept(value);
  }
  return lastPresent(kept, value);
}
