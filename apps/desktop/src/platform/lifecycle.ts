/**
 * What closing the last window means.
 *
 * On macOS an app stays in the dock with no window open and reopens one on
 * `activate` — which is why `main/index.ts` has that handler at all. Quitting
 * there also kills the supervised server mid-turn, so a closed window would
 * abandon a running agent session. Windows and Linux quit.
 */
export const quitsWhenAllWindowsClosed = (platform: string): boolean => platform !== "darwin";
